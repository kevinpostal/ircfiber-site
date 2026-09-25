/*
 * IRC Fiber -- editmessage: IRCv3 draft/edit-message (msgid-keyed).
 *
 * Third-party module for InspIRCd 4. Advertises the draft/edit-message
 * capability. An edit is an ordinary PRIVMSG carrying the client-only tag
 * `+draft/edit=<msgid>` naming the message it replaces; recipients that
 * negotiated message-tags receive the tag (ircv3_ctctags relays every
 * client-only tag) and fold the new text onto that msgid, everyone else
 * sees a normal message. chanhistory persists tags_out, so joiners get
 * edits replayed as-is.
 *
 * What this module adds on top of the tag relay:
 *   - the capability, so clients know edits are honoured;
 *   - authorisation: only the author of <msgid> may edit it, and only from
 *     a connection that negotiated the cap. Anything else is refused with
 *     FAIL EDIT INVALID_TARGET / UNKNOWN_MSGID / EDIT_FORBIDDEN and the
 *     message is dropped (nothing reaches the channel);
 *   - the msgid ring (per channel; per author for private messages) that
 *     answers "who sent <msgid>". An edit's own msgid joins the ring under
 *     the same author, so chained edits may reference either.
 *
 * <editmessage maxlines="1000" maxduration="1w"> bounds the rings; older
 * msgids answer UNKNOWN_MSGID. Mirrors m_messageredaction.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, version 2.
 */

#include "inspircd.h"
#include "modules/cap.h"

namespace
{
	constexpr const char* EDIT_TAG = "+draft/edit";

	struct SentEntry final
	{
		std::string msgid;
		std::string senderuuid;
		std::string peeruuid; // Private messages only: the recipient.
		time_t ts;
	};

	struct History final
	{
		std::deque<SentEntry> sent;

		void Prune(time_t now, size_t maxlines, unsigned long maxduration)
		{
			const time_t cutoff = now - static_cast<time_t>(maxduration);
			while (!sent.empty() && sent.front().ts < cutoff)
				sent.pop_front();
			while (sent.size() > maxlines)
				sent.pop_front();
		}

		const SentEntry* Find(const std::string& msgid) const
		{
			for (const auto& e : sent)
				if (e.msgid == msgid)
					return &e;
			return nullptr;
		}
	};
}

class ModuleEditMessage final
	: public Module
{
private:
	Cap::Capability cap;
	// Fail::Send prints "*" for a null Command and there is no real EDIT
	// command, so the standard reply is built by hand on this provider.
	ClientProtocol::EventProvider failprov;
	SimpleExtItem<History> chanext;
	SimpleExtItem<History> userext;
	size_t maxlines = 1000;
	unsigned long maxduration = 7 * 24 * 3600;

	void Prune(History& hist) const
	{
		hist.Prune(ServerInstance->Time(), maxlines, maxduration);
	}

	// FAIL EDIT <code> <target> [<msgid>] :<description>; "EDIT" is the
	// feature name standard-replies uses when no command is involved.
	void Refuse(LocalUser* user, const std::string& code, const std::string& target, const std::string& msgid, const std::string& description)
	{
		ClientProtocol::Message msg("FAIL", ServerInstance->Config->GetServerName());
		msg.PushParam("EDIT");
		msg.PushParam(code);
		msg.PushParam(target);
		if (!msgid.empty())
			msg.PushParam(msgid);
		msg.PushParam(description);
		ClientProtocol::Event ev(failprov, msg);
		user->Send(ev);
	}

public:
	ModuleEditMessage()
		: Module(VF_NONE, "Provides the draft/edit-message IRCv3 capability (+draft/edit).")
		, cap(this, "draft/edit-message")
		, failprov(this, "FAIL")
		, chanext(this, "edit-history", ExtensionType::CHANNEL)
		, userext(this, "edit-sent", ExtensionType::USER)
	{
	}

	void ReadConfig(ConfigStatus& status) override
	{
		const auto& tag = ServerInstance->Config->ConfValue("editmessage");
		maxlines = tag->getNum<size_t>("maxlines", 1000, 1, 100000);
		maxduration = tag->getDuration("maxduration", 7 * 24 * 3600, 60, 30 * 24 * 3600);
	}

	void Prioritize() override
	{
		// ircv3_ctctags copies client tags into tags_out in its own pre hook;
		// authorising before it runs means a refused edit never reaches it.
		ServerInstance->Modules.SetPriority(this, I_OnUserPreMessage, PRIORITY_FIRST);
	}

	ModResult OnUserPreMessage(User* user, MessageTarget& target, MessageDetails& details) override
	{
		const auto it = details.tags_in.find(EDIT_TAG);
		if (it == details.tags_in.end())
			return MOD_RES_PASSTHRU;

		LocalUser* luser = IS_LOCAL(user);
		if (!luser)
			return MOD_RES_PASSTHRU; // The origin server authorised it.

		const std::string& msgid = it->second.value;
		const std::string& targetname = target.GetName();
		if (!cap.IsEnabled(luser) || msgid.empty())
		{
			Refuse(luser, "INVALID_TARGET", targetname, msgid, "Message editing is not enabled on this connection");
			return MOD_RES_DENY;
		}

		const SentEntry* entry = nullptr;
		if (target.type == MessageTarget::TYPE_CHANNEL)
		{
			History& hist = chanext.GetRef(target.Get<Channel>());
			Prune(hist);
			entry = hist.Find(msgid);
		}
		else if (target.type == MessageTarget::TYPE_USER)
		{
			// Only the author's own ring is consulted, so a non-author can
			// never learn whether a msgid exists.
			History& hist = userext.GetRef(user);
			Prune(hist);
			entry = hist.Find(msgid);
			if (entry && entry->peeruuid != target.Get<User>()->uuid)
				entry = nullptr;
		}
		else
		{
			Refuse(luser, "INVALID_TARGET", targetname, msgid, "You cannot edit messages sent to " + targetname);
			return MOD_RES_DENY;
		}

		if (!entry)
		{
			Refuse(luser, "UNKNOWN_MSGID", targetname, msgid, "This message does not exist or is too old");
			return MOD_RES_DENY;
		}
		if (entry->senderuuid != user->uuid)
		{
			Refuse(luser, "EDIT_FORBIDDEN", targetname, msgid, "You can only edit your own messages");
			return MOD_RES_DENY;
		}
		return MOD_RES_PASSTHRU;
	}

	void OnUserPostMessage(User* user, const MessageTarget& target, const MessageDetails& details) override
	{
		const auto it = details.tags_out.find("msgid");
		if (it == details.tags_out.end() || it->second.value.empty())
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
};

MODULE_INIT(ModuleEditMessage)
