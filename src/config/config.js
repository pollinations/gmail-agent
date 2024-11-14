require("dotenv").config();
const path = require("path");

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
  },
  summary: {
    maxEmailsInSummary: 1000,
  },
};

// Validate required configuration
if (!config.gmail.credentials) {
  console.error("Gmail credentials path is not set in environment variables");
}

module.exports = config;
