require("dotenv").config();
const path = require("path");
const fs = require("fs");
const logger = require("../utils/logger");

function validateConfig(scriptName = '') {
  const errors = [];
  const isExportScript = scriptName.includes('exportResponses');

  // Always validate Gmail credentials as they're needed for all operations
  if (!process.env.GMAIL_CREDENTIALS) {
    errors.push("GMAIL_CREDENTIALS environment variable is not set");
  } else {
    const credentialsPath = path.resolve(process.env.GMAIL_CREDENTIALS);
    if (!fs.existsSync(credentialsPath)) {
      errors.push(`Gmail credentials file not found at: ${credentialsPath}`);
    } else {
      try {
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
        if (!credentials.web?.client_id || !credentials.web?.client_secret) {
          errors.push("Invalid Gmail credentials format - missing client_id or client_secret");
        }
      } catch (error) {
        errors.push(`Error reading Gmail credentials: ${error.message}`);
      }
    }
  }

  // Only check these if not running the export script
  if (!isExportScript) {
    // Check OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      errors.push("OPENAI_API_KEY environment variable is not set");
    }

    // Check Telegram config
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      errors.push("TELEGRAM_BOT_TOKEN environment variable is not set");
    }
    if (!process.env.TELEGRAM_USER_ID) {
      errors.push("TELEGRAM_USER_ID environment variable is not set");
    }
  }

  return errors;
}

const config = {
  gmail: {
    credentials: process.env.GMAIL_CREDENTIALS
      ? path.resolve(process.env.GMAIL_CREDENTIALS)
      : null,
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    userId: process.env.TELEGRAM_USER_ID,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    models: {
      analyze: "gpt-4o-mini",
      compose: "gpt-4"
    }
  },
  summary: {
    maxEmailsInSummary: 1000,
  },
};

// Get the current script name
const scriptName = process.argv[1] || '';

// Validate configuration based on script
const configErrors = validateConfig(scriptName);
if (configErrors.length > 0) {
  logger.error("Configuration validation failed:", { errors: configErrors });
  throw new Error(`Configuration errors:\n${configErrors.join('\n')}`);
}

module.exports = config;
