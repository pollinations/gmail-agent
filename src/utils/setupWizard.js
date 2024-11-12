const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const logger = require("./logger");

class SetupWizard {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }

  async question(query) {
    return new Promise((resolve) => this.rl.question(query, resolve));
  }

  async run() {
    console.log("\n🔧 Welcome to Email AI Agent Setup Wizard!\n");

    const config = {
      gmail: {
        credentials: "",
        token: "",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
      telegram: {
        botToken: "",
        userId: "",
      },
      openai: {
        apiKey: "",
      },
    };

    try {
      // Gmail Setup
      console.log("\n📧 Gmail Configuration:");
      console.log("Please follow these steps to set up Gmail API:");
      console.log(
        "1. Go to Google Cloud Console (https://console.cloud.google.com)"
      );
      console.log("2. Create a new project or select existing one");
      console.log("3. Enable Gmail API");
      console.log("4. Create credentials (OAuth 2.0 Client ID)");
      console.log("5. Download the credentials JSON file\n");

      config.gmail.credentials = await this.question(
        "Enter the path to your Gmail credentials JSON file: "
      );

      // Convert to absolute path and validate
      const credentialsPath = path.resolve(config.gmail.credentials);
      if (!fs.existsSync(credentialsPath)) {
        throw new Error(`Credentials file not found at: ${credentialsPath}`);
      }

      // Telegram Setup
      console.log("\n📱 Telegram Configuration:");
      console.log("Please follow these steps to set up Telegram Bot:");
      console.log("1. Open Telegram and search for @BotFather");
      console.log("2. Send /newbot and follow the instructions");
      console.log("3. Copy the bot token provided by BotFather");
      console.log("4. Start a chat with your bot and send /start");
      console.log("5. Get your User ID by sending /start to @userinfobot\n");

      config.telegram.botToken = await this.question(
        "Enter your Telegram Bot Token: "
      );
      config.telegram.userId = await this.question(
        "Enter your Telegram User ID: "
      );

      // OpenAI Setup
      console.log("\n🤖 OpenAI Configuration:");
      console.log(
        "Get your API key from: https://platform.openai.com/account/api-keys\n"
      );
      config.openai.apiKey = await this.question("Enter your OpenAI API key: ");

      // Save configuration
      const envContent = `
GMAIL_CREDENTIALS=${credentialsPath}
TELEGRAM_BOT_TOKEN=${config.telegram.botToken}
TELEGRAM_USER_ID=${config.telegram.userId}
OPENAI_API_KEY=${config.openai.apiKey}
`;

      await promisify(fs.writeFile)(".env", envContent.trim());

      console.log("\n✅ Configuration completed successfully!");
      console.log("The configuration has been saved to .env file");
      console.log(
        "\n⚠️ On first run, you will need to authenticate with your Google account."
      );
      console.log("A browser window will open for authentication.\n");
    } catch (error) {
      console.error("\n❌ Setup failed:", error.message);
      throw error;
    } finally {
      this.rl.close();
    }
  }
}

module.exports = new SetupWizard();
