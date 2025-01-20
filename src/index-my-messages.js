const config = require("./config/config");
const logger = require("./utils/logger");
const fs = require("fs");
const path = require("path");
const cleanEmailThread = require('./utils/cleanEmailThread');

// Move service requires inside functions to prevent early initialization
let emailService;

async function loadServices() {
  try {
    emailService = require("./services/emailService");
    logger.info("Services loaded successfully");
  } catch (error) {
    logger.error("Error loading services", { error: error.message });
    throw error;
  }
}

async function extractMyMessages(threads, userEmail) {
  const myMessages = [];
  
  for (const thread of threads) {
    // Clean the thread messages first
    const cleanedMessages = cleanEmailThread(thread.messages);
    
    // Extract messages written by me
    const myThreadMessages = cleanedMessages.filter(msg => {
      const fromEmail = msg.from.toLowerCase();
      return fromEmail.includes(userEmail.toLowerCase());
    });
    
    if (myThreadMessages.length > 0) {
      myMessages.push({
        threadId: thread.threadId,
        subject: thread.subject,
        messages: myThreadMessages
      });
    }
  }
  
  return myMessages;
}

async function writeToMarkdown(myMessages) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join('context', `my-messages-${timestamp}.md`);
  
  let content = '# My Email Messages\n\n';
  
  for (const thread of myMessages) {
    content += `## Thread: ${thread.subject || 'No Subject'}\n\n`;
    
    for (const msg of thread.messages) {
      const date = new Date(parseInt(msg.internalDate)).toLocaleString();
      content += `### ${date}\n\n`;
      content += `${msg.body}\n\n---\n\n`;
    }
  }
  
  fs.writeFileSync(outputPath, content, 'utf8');
  return outputPath;
}

async function downloadMyMessages() {
  try {
    logger.info("Starting email fetch");
    await loadServices();
    
    // Initialize Gmail service
    await emailService.initialize();
    logger.info("Email service initialized");

    // Fetch email threads
    const threads = await emailService.fetchEmailThreads(500);
    logger.info(`Found ${threads.length} threads`);

    // Get user's email from the service
    const userEmail = await emailService.getUserEmail();
    logger.info(`Processing messages for: ${userEmail}`);

    // Extract my messages from threads
    const myMessages = await extractMyMessages(threads, userEmail);
    logger.info(`Found ${myMessages.length} threads containing my messages`);

    // Write to markdown file
    const outputPath = await writeToMarkdown(myMessages);
    logger.info(`Messages written to: ${outputPath}`);

  } catch (error) {
    logger.error("Error processing messages:", error);
    throw error;
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
    promise: promise,
  });
  process.exit(1);
});

// Run the script
downloadMyMessages().catch((error) => {
  logger.error("Failed to download messages:", error);
  process.exit(1);
});
