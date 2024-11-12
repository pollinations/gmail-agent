# Gmail AI Agent 📧 🤖

An intelligent email management system that automates email processing using AI. The system analyzes emails, suggests actions, and allows control through Telegram.

## Features 🌟

- **AI-Powered Analysis**: Uses GPT models to understand email context and intent
- **Smart Response Generation**: Creates contextually appropriate responses
- **Bulk Email Management**: Groups and handles similar emails efficiently
- **Vector Similarity**: Uses embeddings to find truly similar emails
- **Telegram Control**: Full email management through Telegram interface
- **Multi-language Support**: Handles emails in any language
- **Smart Threading**: Understands email conversation context
- **Customizable Actions**: Archive, respond, or request more information

## Prerequisites 📋

- Node.js v16+
- Gmail Account with API access
- Telegram Bot Token
- OpenAI API Key

## Quick Start 🚀

1. Clone and install:

```bash
git clone https://github.com/olivierloverde/gmail-agent.git
cd gmail-agent
npm install
```

2. Run the automated setup wizard:

```bash
npm start
```

The setup wizard will:

- Guide you through API setup process
- Help create necessary credentials
- Configure environment variables
- Set up Gmail authentication
- Configure Telegram bot
- Test all connections

## Detailed Setup Guide 📖

### Automated Setup Wizard

On first run, the application will launch an interactive setup wizard that will:

1. Check for missing configurations
2. Guide you through obtaining necessary API keys
3. Help you set up:
   - Gmail API credentials
   - Telegram bot token
   - OpenAI API key
4. Create and configure the `.env` file automatically
5. Validate all credentials
6. Initialize required directories and files

The wizard will provide step-by-step instructions for:

### Gmail API Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project or select existing
3. Enable Gmail API
4. Create OAuth 2.0 credentials
5. Download credentials file

### Telegram Bot Setup

1. Message [@BotFather](https://t.me/botfather)
2. Create new bot
3. Get bot token
4. Get user ID from [@userinfobot](https://t.me/userinfobot)

### OpenAI API Setup

1. Visit [OpenAI Platform](https://platform.openai.com)
2. Create API key

The wizard will automatically save all configurations to the `.env` file.

## Usage Guide 💡

### Telegram Commands

- `1` - Confirm suggested action
- `2` - Reject suggestion
- `3` - Edit response/Force reply
- `4` - Force archive (for RESPOND actions)

### Email Processing

The system will:

1. Fetch unread emails
2. Analyze content using AI
3. Send Telegram notification
4. Wait for your action
5. Execute chosen action

### Bulk Operations

When archiving, the system:

1. Checks for similar emails
2. Shows bulk archive options
3. Allows individual selection

## Configuration ⚙️

After initial setup, you can manually adjust settings in `.env`:

```env
GMAIL_CREDENTIALS=./credentials.json
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_USER_ID=your_user_id
OPENAI_API_KEY=your_openai_key
```

### Advanced Settings

Adjust in `src/services/emailService.js`:

```javascript
this.similarityThreshold = 0.85; // Similarity detection threshold
maxResults: 500, // Number of emails per batch
```

## Troubleshooting 🔍

### Authentication Issues

If authentication fails:

```bash
rm token.json
npm start
```

The setup wizard will automatically run if configuration is missing.

### Rate Limits

If hitting API limits:

1. Increase delays between requests
2. Reduce batch sizes
3. Adjust similarity thresholds

### Message Format Errors

If Telegram messages fail:

1. Check special characters
2. Verify markdown syntax
3. Reduce message length

## Support and Contribution 🤝

- Report issues on GitHub
- Submit pull requests

## License 📄

MIT License - See LICENSE file

## Security Notes 🔒

- Credentials are automatically secured
- Environment variables are properly handled
- API keys are stored safely
- Access is limited to authorized user
