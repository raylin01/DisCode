---
name: Discord Integration
description: Interact with the Discord channel tied to this session. You can send messages (with embeds) and update the channel name/description.
allowed-tools: [DiscordMessage, DiscordUpdateChannel]
---

# Discord Integration Skills

This skill allows you to communicate directly with the users in the Discord channel.

## Actions

### Send Message
Send a message to the Discord channel. Supporting markdown and pings.

**Usage**:
Execute the `send-to-discord.sh` script.

```bash
/path/to/bin/send-to-discord.sh "Your message content here"

# With Embed options
/path/to/bin/send-to-discord.sh --title "Tasks Completed" --color "green" --description "I have finished the user authentication module."
```

### Update Channel
Rename the channel and update its description to reflect the current task status.
Use this proactively when the session's topic changes significantly.

**Usage**:
Execute the `update-channel.sh` script.

```bash
/path/to/bin/update-channel.sh "new-channel-name" "New channel description"
```
