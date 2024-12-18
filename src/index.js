const config = require("./config/config");
const logger = require("./utils/logger");
const setupWizard = require("./utils/setupWizard");
const setup = require("./utils/setup");
const fs = require("fs");

// Move service requires inside functions to prevent early initialization
let emailService, aiService, telegramService;

async function loadServices() {
  try {
    emailService = require("./services/emailService");
    aiService = require("./services/aiService");
    telegramService = require("./services/telegramService");
    logger.info("Services loaded successfully");
  } catch (error) {
    logger.error("Error loading services", { error: error.message });
    throw error;
  }
}

async function checkConfig() {
  if (!fs.existsSync(".env")) {
    logger.info("No configuration found. Starting setup wizard...");
    await setupWizard.run();
    // Reload config after setup
    delete require.cache[require.resolve("./config/config")];
    return require("./config/config");
  }
  return config;
}

async function waitForUserResponse() {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (
        !telegramService.pendingConfirmations.has(
          parseInt(config.telegram.userId)
        )
      ) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 250); // Further reduced to 250ms for even faster response
  });
}

async function processEmail(email) {
  try {
    // Skip if email has been processed
    if (emailService.processedEmails.has(email.id)) {
      logger.info(`Skipping already processed email ${email.id} - Subject: "${email.subject}"`);
      return;
    }

    // Analyze email
    logger.info(`Analyzing email ${email.id}`);
    const analysis = await aiService.analyzeEmail(email);

    // Send confirmation request
    await telegramService.sendConfirmation(
      config.telegram.userId,
      email,
      analysis
    );

    // Wait for user response before proceeding
    logger.info(`Waiting for user response for email ${email.id}`);
    await waitForUserResponse();
    logger.info(`User responded to email ${email.id}`);
  } catch (error) {
    console.error(error);
    logger.error(`Error processing email ${email.id}`, {
      error: error.message,
      stack: error.stack,
      subject: email.subject
    });
  }
}

async function processEmails() {
  try {
    // Initialize services
    logger.info("Initializing services...");

    try {
      await emailService.initialize();
      logger.info("Email service initialized");
    } catch (error) {
      console.error("Failed to initialize email service:", error);
      logger.error("Failed to initialize email service", {
        error: error.message,
      });
      throw error;
    }

    try {
      await telegramService.initialize();
      logger.info("Telegram service initialized");
    } catch (error) {
      console.error("Failed to initialize telegram service:", error);
      logger.error("Failed to initialize telegram service", {
        error: error.message,
      });
      throw error;
    }

    // Fetch unread emails
    const emails = await emailService.fetchUnreadEmails();
    logger.info(`Found ${emails.length} unread emails`);

    // Process each email that hasn't been processed yet
    for (const email of emails) {
      if (!emailService.processedEmails.has(email.id)) {
        await processEmail(email);
      } else {
        logger.info(`Skipping already processed email ${email.id} - Subject: "${email.subject}"`);
      }
    }

    logger.info("Finished processing all emails");
  } catch (error) {
    console.error("Error in email processing cycle:", error);
    logger.error("Error in email processing cycle", {
      error: error.message,
      stack: error.stack,
    });

    // If initialization failed, exit the process
    if (error.message.includes("Failed to initialize")) {
      logger.error("Critical initialization error, exiting...");
      throw error;
    }
  }
}

async function main() {
  try {
    // Ensure required directories exist
    setup.ensureDirectoriesExist();

    // Check required files
    if (!setup.checkRequiredFiles()) {
      throw new Error("Missing required files");
    }

    // Check and setup configuration
    await checkConfig();

    // Load services after config is ready
    await loadServices();

    // Start the email processing
    logger.info("Starting email processing service");

    // Run initial process
    await processEmails();

    // Set up interval for future checks
    setInterval(async () => {
      if (
        !telegramService.pendingConfirmations.has(
          parseInt(config.telegram.userId)
        )
      ) {
        await processEmails();
      }
    }, 60 * 1000); // Reduced to 1 minute for more frequent checks

    // Handle process termination
    process.on("SIGINT", () => {
      logger.info("Service shutting down");
      process.exit(0);
    });
  } catch (error) {
    logger.error("Failed to start service", {
      error: error.message,
      stack: error.stack,
    });
    console.error(error);
    process.exit(1);
  }
}

// Add global error handlers
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection:", {
    reason: reason,
    stack: reason?.stack,
  });
  process.exit(1);
});

main();
