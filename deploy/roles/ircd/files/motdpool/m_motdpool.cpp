/*
 * IRC Fiber -- motdpool: a per-connect, per-user templated message of the day.
 *
 * Third-party module for InspIRCd 4. Intercepts MOTD (the connect-time
 * dispatch in CoreModInfo::OnUserConnect and the /MOTD command both arrive
 * through OnPreCommand("MOTD", validated=true)) and serves one randomly
 * drawn block from a pool file, substituting {placeholders} from per-user
 * data. The pool and the profiles are plain files written by the gateway
 * into the ircd's conf dir; both are re-read through ServerConfig::ReadFile
 * every <motdpool:cachetime>, so no REHASH is needed to pick up new content.
 *
 * Pool file (<motdpool:pool>, default motd.d/pool): UTF-8 text, blocks
 * separated by a line consisting of exactly "%%". A block whose first line
 * is "#id: <slug>" ([A-Za-z0-9_-]{1,32}) is named; the header line is never
 * sent. Whitespace-only blocks are dropped.
 *
 * Profiles file (<motdpool:profiles>, default motd.d/profiles): one record
 * per line, TAB separated: "<address>\t<field>=<value>\t<field>=<value>...".
 * The record whose key equals the user's address is used; otherwise the
 * record under the reserved key "default". A record's "motd" field names
 * the block id to serve that user instead of a random draw.
 *
 * A missing or empty pool falls through (MOD_RES_PASSTHRU) to the core MOTD
 * from <files motd>, so a failed gateway write can never yield an empty MOTD.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, version 2.
 */

#include "inspircd.h"
#include "timeutils.h"

enum
{
	// From RFC 1459
	RPL_MOTD = 372,
	RPL_MOTDSTART = 375,
	RPL_ENDOFMOTD = 376,
};

class ModuleMotdPool final
	: public Module
{
private:
	// Caps. Rendered lines are held to the same byte budget the gateway
	// enforces on templates (MOTD_MAX_LINE_LENGTH), which keeps
	// ":server 372 <nick> :<line>" inside the 512 byte protocol limit.
	static constexpr size_t MAX_BLOCK_LINES = 200;
	static constexpr size_t MAX_LINE_BYTES = 400;
	static constexpr size_t MAX_PROFILES = 20000;
	static constexpr size_t MAX_PROFILE_BYTES = 4 * 1024 * 1024;

	typedef insp::flat_map<std::string, std::string> Profile;

	struct Pool final
	{
		time_t parsed = 0;
		std::vector<std::string> ids;
		std::vector<std::vector<std::string>> blocks;
	};

	std::string poolfile;
	std::string profilefile;
	unsigned long cachesecs = 0;
	size_t maxblocks = 0;

	// Keyed by the pool path resolved for the user's connect class.
	insp::flat_map<std::string, Pool> pools;
	time_t profilesparsed = 0;
	insp::flat_map<std::string, Profile> profiles;

	static bool IsBlockId(const std::string& id)
	{
		if (id.empty() || id.length() > 32)
			return false;
		for (const auto chr : id)
		{
			if (!isalnum(static_cast<unsigned char>(chr)) && chr != '_' && chr != '-')
				return false;
		}
		return true;
	}

	static bool IsBlank(const std::vector<std::string>& lines)
	{
		for (const auto& line : lines)
		{
			for (const auto chr : line)
			{
				if (!isspace(static_cast<unsigned char>(chr)))
					return false;
			}
		}
		return true;
	}

	static void StripCR(std::string& line)
	{
		if (!line.empty() && line.back() == '\r')
			line.pop_back();
	}

	// Finalises one block: drops it if blank, consumes the "#id:" header,
	// pre-processes colour escapes (on the template, never on substituted
	// values), and enforces the per-block line cap.
	void PushBlock(Pool& pool, std::vector<std::string>& lines, const std::string& path, bool& warnedlines) const
	{
		if (IsBlank(lines))
		{
			lines.clear();
			return;
		}

		std::string id;
		if (!lines.empty() && lines.front().compare(0, 5, "#id: ") == 0)
		{
			const std::string candidate = lines.front().substr(5);
			if (IsBlockId(candidate))
			{
				id = candidate;
				lines.erase(lines.begin());
			}
		}

		if (lines.size() > MAX_BLOCK_LINES)
		{
			if (!warnedlines)
			{
				ServerInstance->Logs.Warning(MODNAME, "MOTD pool {} has a block longer than {} lines; truncating", path, MAX_BLOCK_LINES);
				warnedlines = true;
			}
			lines.resize(MAX_BLOCK_LINES);
		}

		for (auto& line : lines)
			InspIRCd::ProcessColors(line);

		pool.ids.push_back(id);
		pool.blocks.push_back(std::move(lines));
		lines.clear();
	}

	Pool* GetPool(const std::string& path)
	{
		const time_t now = ServerInstance->Time();
		Pool& pool = pools[path];
		if (pool.parsed && pool.parsed + static_cast<time_t>(cachesecs) > now)
			return pool.blocks.empty() ? nullptr : &pool;

		pool.parsed = now;
		pool.ids.clear();
		pool.blocks.clear();

		auto file = ServerInstance->Config->ReadFile(path, now - static_cast<time_t>(cachesecs));
		if (!file)
		{
			// Negative cache: one warning per cachetime, every connect in the
			// window falls through to the core MOTD.
			ServerInstance->Logs.Warning(MODNAME, "Unable to read MOTD pool {}: {}", path, file.error);
			return nullptr;
		}

		bool warnedblocks = false;
		bool warnedlines = false;
		std::vector<std::string> current;
		irc::sepstream linestream(file.contents, '\n', true);
		for (std::string line; linestream.GetToken(line); )
		{
			StripCR(line);
			if (line != "%%")
			{
				current.push_back(line);
				continue;
			}

			if (pool.blocks.size() >= maxblocks)
			{
				if (!warnedblocks)
				{
					ServerInstance->Logs.Warning(MODNAME, "MOTD pool {} has more than {} blocks; ignoring the rest", path, maxblocks);
					warnedblocks = true;
				}
				current.clear();
				break;
			}
			PushBlock(pool, current, path, warnedlines);
		}
		if (!current.empty() && pool.blocks.size() < maxblocks)
			PushBlock(pool, current, path, warnedlines);

		return pool.blocks.empty() ? nullptr : &pool;
	}

	void ReadProfiles()
	{
		const time_t now = ServerInstance->Time();
		if (profilesparsed && profilesparsed + static_cast<time_t>(cachesecs) > now)
			return;

		profilesparsed = now;
		profiles.clear();

		auto file = ServerInstance->Config->ReadFile(profilefile, now - static_cast<time_t>(cachesecs));
		if (!file)
		{
			ServerInstance->Logs.Warning(MODNAME, "Unable to read MOTD profiles {}: {}", profilefile, file.error);
			return;
		}

		if (file.contents.size() > MAX_PROFILE_BYTES)
			ServerInstance->Logs.Warning(MODNAME, "MOTD profiles {} is larger than {} bytes; records past that are ignored", profilefile, MAX_PROFILE_BYTES);

		size_t consumed = 0;
		irc::sepstream linestream(file.contents, '\n', true);
		for (std::string line; linestream.GetToken(line); )
		{
			consumed += line.length() + 1;
			if (consumed > MAX_PROFILE_BYTES)
				break;

			if (profiles.size() >= MAX_PROFILES)
			{
				ServerInstance->Logs.Warning(MODNAME, "MOTD profiles {} has more than {} records; ignoring the rest", profilefile, MAX_PROFILES);
				break;
			}

			StripCR(line);
			if (line.empty())
				continue;

			irc::sepstream fieldstream(line, '\t');
			std::string key;
			if (!fieldstream.GetToken(key) || key.empty())
				continue;

			Profile& profile = profiles[key];
			for (std::string field; fieldstream.GetToken(field); )
			{
				const size_t eq = field.find('=');
				if (eq == std::string::npos || eq == 0)
					continue;
				profile[field.substr(0, eq)] = field.substr(eq + 1);
			}
		}
	}

	// Expands {key} ([a-z0-9_]+) from vars; an unknown key renders as the
	// empty string. Nothing else is interpreted.
	static std::string Render(const std::string& tmpl, const Profile& vars)
	{
		std::string out;
		out.reserve(tmpl.length());
		for (size_t idx = 0; idx < tmpl.length(); )
		{
			if (tmpl[idx] != '{')
			{
				out.push_back(tmpl[idx++]);
				continue;
			}

			size_t end = idx + 1;
			while (end < tmpl.length() && (islower(static_cast<unsigned char>(tmpl[end])) || isdigit(static_cast<unsigned char>(tmpl[end])) || tmpl[end] == '_'))
				end++;

			if (end == idx + 1 || end >= tmpl.length() || tmpl[end] != '}')
			{
				out.push_back(tmpl[idx++]);
				continue;
			}

			const auto var = vars.find(tmpl.substr(idx + 1, end - idx - 1));
			if (var != vars.end())
				out.append(var->second);
			idx = end + 1;
		}

		// Truncate to the byte budget, backed off to the start of the UTF-8
		// sequence so a multibyte value is never cut mid-codepoint.
		if (out.length() > MAX_LINE_BYTES)
		{
			size_t cut = MAX_LINE_BYTES;
			while (cut > 0 && (static_cast<unsigned char>(out[cut]) & 0xC0) == 0x80)
				cut--;
			out.resize(cut);
		}

		// Some clients can not handle receiving RPL_MOTD with an empty
		// trailing parameter so if a line is empty we replace it with
		// a single space.
		return out.empty() ? " " : out;
	}

public:
	ModuleMotdPool()
		: Module(VF_NONE, "Serves a random, per-user templated message of the day.")
	{
	}

	void ReadConfig(ConfigStatus& status) override
	{
		const auto& tag = ServerInstance->Config->ConfValue("motdpool");
		poolfile = tag->getString("pool", "motd.d/pool", 1);
		profilefile = tag->getString("profiles", "motd.d/profiles", 1);
		cachesecs = tag->getDuration("cachetime", 60, 5, 3600);
		maxblocks = tag->getNum<size_t>("maxblocks", 200, 1, 2000);

		// A rehash always re-reads both files.
		pools.clear();
		profiles.clear();
		profilesparsed = 0;
	}

	ModResult OnPreCommand(std::string& command, CommandBase::Params& parameters, LocalUser* user, bool validated) override
	{
		if (!validated || !irc::equals(command, "MOTD"))
			return MOD_RES_PASSTHRU;

		// A remote /MOTD stays core's job.
		if (!parameters.empty() && !irc::equals(parameters[0], ServerInstance->Config->ServerName))
			return MOD_RES_PASSTHRU;

		const std::string path = user->GetClass()->config->getString("motdpool", poolfile, 1);
		Pool* pool = GetPool(path);
		if (!pool)
			return MOD_RES_PASSTHRU;

		ReadProfiles();
		Profile vars;
		auto profile = profiles.find(user->GetAddress());
		if (profile == profiles.end())
			profile = profiles.find("default");
		if (profile != profiles.end())
			vars = profile->second;

		vars["nick"] = user->nick;
		vars["user"] = user->GetRealUser();
		vars["host"] = user->GetDisplayedHost();
		vars["ip"] = user->GetAddress();
		vars["realname"] = user->GetRealName();
		vars["class"] = user->GetClass()->GetName();
		vars["server"] = ServerInstance->Config->GetServerName();
		vars["network"] = ServerInstance->Config->Network;
		vars["users"] = ConvToStr(ServerInstance->Users.GlobalUserCount());
		vars["localusers"] = ConvToStr(ServerInstance->Users.LocalUserCount());
		vars["time"] = Time::ToString(ServerInstance->Time());

		// A profile may pin one named block; otherwise one independent
		// random draw per MOTD request.
		size_t index = pool->blocks.size();
		const auto pinned = vars.find("motd");
		if (pinned != vars.end() && !pinned->second.empty())
		{
			for (size_t i = 0; i < pool->ids.size(); ++i)
			{
				if (pool->ids[i] == pinned->second)
				{
					index = i;
					break;
				}
			}
		}
		if (index >= pool->blocks.size())
			index = ServerInstance->GenRandomInt(pool->blocks.size());

		user->WriteNumeric(RPL_MOTDSTART, INSP_FORMAT("{} message of the day:", ServerInstance->Config->GetServerName()));
		for (const auto& line : pool->blocks[index])
			user->WriteNumeric(RPL_MOTD, Render(line, vars));
		user->WriteNumeric(RPL_ENDOFMOTD, "End of message of the day.");
		return MOD_RES_DENY;
	}
};

MODULE_INIT(ModuleMotdPool)
