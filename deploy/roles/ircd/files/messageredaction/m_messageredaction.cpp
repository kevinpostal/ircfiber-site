/*
 * IRC Fiber -- messageredaction: IRCv3 draft/message-redaction.
 *
 * Third-party module for InspIRCd 4. Implements
 * https://ircv3.net/specs/extensions/message-redaction: advertises the
 * draft/message-redaction capability and the REDACT command
 * (REDACT <target> <msgid> [:<reason>]).
 *
 * Policy: a message's author may always redact it. In channels, members
 * with +o or higher (+a/+q) and server opers holding the
 * channels/redact-message privilege may redact anyone's message. Private
 * messages are author-only.
 *
 * Every PRIVMSG/NOTICE/TAGMSG that leaves with a msgid tag (set by
 * ircv3_msgid) is remembered: per channel for channel messages, per
 * author for private messages. <messageredaction maxlines> and
 * <messageredaction maxduration> bound those rings; a msgid outside them
 * answers FAIL REDACT UNKNOWN_MSGID. Channel redactions are also kept
 * (same bounds) and replayed to joining clients that negotiated the cap,
 * after chanhistory has replayed the messages themselves. Clients ignore
 * a REDACT for a msgid they do not hold (spec), so the replay is
 * harmless for a joiner who never saw the message.
 *
 * REDACT is relayed only to recipients that negotiated the cap, the
 * redactor included (echo). Users without the cap get nothing.
 *
 * Routing: the command is ENCAP-broadcast (ROUTE_OPT_BCAST) so a linked
 * server that also loads this module runs the delivery path for its own
 * local members; servers without it silently drop the ENCAP. Remote
 * requesters are not re-validated (their origin server did that).
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, version 2.
 */

#include "inspircd.h"
#include "modules/cap.h"
#include "modules/ctctags.h"
#include "modules/ircv3_replies.h"

class ModuleMessageRedaction;

namespace
{
	// Keeps ":nick!user@host REDACT #channel <msgid> :<reason>" inside the
	// 512 byte protocol limit with any hostmask and channel name.
	constexpr size_t MAX_REASON_BYTES = 300;

	constexpr const char* PRIV_REDACT = "channels/redact-message";

	struct SentEntry final
	{
		std::string msgid;
		std::string senderuuid;
		std::string peeruuid; // Private messages only: the recipient.
		time_t ts;
	};

	struct RedactEntry final
	{
		std::string msgid;
		std::string redactor; // nick!user@host at redaction time.
		std::string reason;
		time_t ts;
	};

	struct History final
	{
		std::deque<SentEntry> sent;
		std::deque<RedactEntry> redactions;

		void Prune(time_t now, size_t maxlines, unsigned long maxduration)
		{
			const time_t cutoff = now - static_cast<time_t>(maxduration);
			while (!sent.empty() && sent.front().ts < cutoff)
				sent.pop_front();
			while (!redactions.empty() && redactions.front().ts < cutoff)
				redactions.pop_front();
			while (sent.size() > maxlines)
				sent.pop_front();
			while (redactions.size() > maxlines)
				redactions.pop_front();
		}
	};

	// Truncates to the byte budget, backed off to the start of the UTF-8
	// sequence so a reason is never cut mid-codepoint.
	void ClampReason(std::string& reason)
	{
		if (reason.length() <= MAX_REASON_BYTES)
			return;
		size_t cut = MAX_REASON_BYTES;
		while (cut > 0 && (static_cast<unsigned char>(reason[cut]) & 0xC0) == 0x80)
			cut--;
		reason.resize(cut);
	}
}

class CommandRedact final
	: public Command
{
private:
	ModuleMessageRedaction& mod;

public:
	CommandRedact(ModuleMessageRedaction& parent);

	RouteDescriptor GetRouting(User* user, const Params& params) override
	{
		return ROUTE_OPT_BCAST;
	}

	CmdResult Handle(User* user, const Params& params) override;
};

class ModuleMessageRedaction final
	: public Module
	, public CTCTags::EventListener
{
public:
	Cap::Capability cap;
	IRCv3::Replies::Fail fail;
	ClientProtocol::EventProvider redactprov;
	SimpleExtItem<History> chanext;
	SimpleExtItem<History> userext;
	CommandRedact cmd;
	size_t maxlines = 1000;
	unsigned long maxduration = 7 * 24 * 3600;

	ModuleMessageRedaction()
		: Module(VF_NONE, "Provides the draft/message-redaction IRCv3 capability (REDACT).")
		, CTCTags::EventListener(this)
		, cap(this, "draft/message-redaction")
		, fail(this)
		, redactprov(this, "REDACT")
		, chanext(this, "redact-history", ExtensionType::CHANNEL)
		, userext(this, "redact-sent", ExtensionType::USER)
		, cmd(*this)
	{
	}

	void ReadConfig(ConfigStatus& status) override
	{
		const auto& tag = ServerInstance->Config->ConfValue("messageredaction");
		maxlines = tag->getNum<size_t>("maxlines", 1000, 1, 100000);
		maxduration = tag->getDuration("maxduration", 7 * 24 * 3600, 60, 30 * 24 * 3600);
	}

	void Prioritize() override
	{
		// After chanhistory has replayed the messages the redactions refer to.
		ServerInstance->Modules.SetPriority(this, I_OnPostJoin, PRIORITY_LAST);
	}

	void Prune(History& hist) const
	{
		hist.Prune(ServerInstance->Time(), maxlines, maxduration);
	}

	void Record(User* user, const MessageTarget& target, const ClientProtocol::TagMap& tags)
	{
		const auto it = tags.find("msgid");
		if (it == tags.end() || it->second.value.empty())
			return;

		const time_t now = ServerInstance->Time();
		if (target.type == MessageTarget::TYPE_CHANNEL)
		{
			History& hist = chanext.GetRef(target.Get<Channel>());
			hist.sent.push_back({ it->second.value, user->uuid, "", now });
			Prune(hist);
		}
		else if (target.type == MessageTarget::TYPE_USER)
		{
			History& hist = userext.GetRef(user);
			hist.sent.push_back({ it->second.value, user->uuid, target.Get<User>()->uuid, now });
			Prune(hist);
		}
	}

	void OnUserPostMessage(User* user, const MessageTarget& target, const MessageDetails& details) override
	{
		Record(user, target, details.tags_out);
	}

	void OnUserPostTagMessage(User* user, const MessageTarget& target, const CTCTags::TagMessageDetails& details) override
	{
		Record(user, target, details.tags_out);
	}

	void OnPostJoin(Membership* memb) override
	{
		LocalUser* localuser = IS_LOCAL(memb->user);
		if (!localuser || !cap.IsEnabled(localuser))
			return;

		History* hist = chanext.Get(memb->chan);
		if (!hist)
			return;

		Prune(*hist);
		for (const auto& entry : hist->redactions)
		{
			ClientProtocol::Message msg("REDACT", entry.redactor);
			msg.PushParamRef(memb->chan->name);
			msg.PushParamRef(entry.msgid);
			if (!entry.reason.empty())
				msg.PushParamRef(entry.reason);
			ClientProtocol::Event ev(redactprov, msg);
			localuser->Send(ev);
		}
	}
};

CommandRedact::CommandRedact(ModuleMessageRedaction& parent)
	: Command(&parent, "REDACT", 2, 3)
	, mod(parent)
{
	syntax = { "<target> <msgid> [:<reason>]" };
}

CmdResult CommandRedact::Handle(User* user, const Params& params)
{
	const std::string& target = params[0];
	const std::string& msgid = params[1];
	std::string reason = params.size() > 2 ? params[2] : "";
	ClampReason(reason);

	// A remote requester was validated by its origin server; only deliver.
	LocalUser* luser = IS_LOCAL(user);
	const time_t now = ServerInstance->Time();

	ClientProtocol::Message msg("REDACT", user);
	msg.PushParamRef(target);
	msg.PushParamRef(msgid);
	if (!reason.empty())
		msg.PushParamRef(reason);
	ClientProtocol::Event ev(mod.redactprov, msg);

	if (ServerInstance->Channels.IsChannel(target))
	{
		Channel* chan = ServerInstance->Channels.Find(target);
		if (!chan || (luser && !chan->HasUser(user)))
		{
			if (luser)
				mod.fail.Send(luser, this, "INVALID_TARGET", target, "You cannot delete messages from " + target);
			return CmdResult::FAILURE;
		}

		History& hist = mod.chanext.GetRef(chan);
		mod.Prune(hist);
		auto entry = std::find_if(hist.sent.begin(), hist.sent.end(), [&msgid](const SentEntry& e) { return e.msgid == msgid; });
		if (luser)
		{
			if (entry == hist.sent.end())
			{
				mod.fail.Send(luser, this, "UNKNOWN_MSGID", target, msgid, "This message does not exist or is too old");
				return CmdResult::FAILURE;
			}

			const bool authorised = entry->senderuuid == user->uuid
				|| chan->GetPrefixValue(user) >= OP_VALUE
				|| user->HasPrivPermission(PRIV_REDACT);
			if (!authorised)
			{
				mod.fail.Send(luser, this, "REDACT_FORBIDDEN", target, msgid, "You are not authorised to delete this message");
				return CmdResult::FAILURE;
			}
		}

		if (entry != hist.sent.end())
			hist.sent.erase(entry);
		hist.redactions.push_back({ msgid, user->GetMask(), reason, now });
		mod.Prune(hist);

		for (const auto& [member, memb] : chan->GetUsers())
		{
			LocalUser* lu = IS_LOCAL(member);
			if (lu && mod.cap.IsEnabled(lu))
				lu->Send(ev);
		}
		return CmdResult::SUCCESS;
	}

	User* dest = ServerInstance->Users.FindNick(target, true);
	if (!dest)
	{
		if (luser)
			mod.fail.Send(luser, this, "INVALID_TARGET", target, "You cannot delete messages from " + target);
		return CmdResult::FAILURE;
	}

	if (luser)
	{
		// Only the author's own ring is consulted, so a non-author can never
		// learn whether a msgid exists.
		History& hist = mod.userext.GetRef(user);
		mod.Prune(hist);
		auto entry = std::find_if(hist.sent.begin(), hist.sent.end(), [&msgid, dest](const SentEntry& e) { return e.msgid == msgid && e.peeruuid == dest->uuid; });
		if (entry == hist.sent.end())
		{
			mod.fail.Send(luser, this, "UNKNOWN_MSGID", target, msgid, "This message does not exist or is too old");
			return CmdResult::FAILURE;
		}
		hist.sent.erase(entry);
	}

	LocalUser* ldest = IS_LOCAL(dest);
	if (ldest && mod.cap.IsEnabled(ldest))
		ldest->Send(ev);
	if (luser && luser != ldest && mod.cap.IsEnabled(luser))
		luser->Send(ev);
	return CmdResult::SUCCESS;
}

MODULE_INIT(ModuleMessageRedaction)
