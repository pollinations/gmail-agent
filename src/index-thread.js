const config = require("./config/config");
const logger = require("./utils/logger");
const setupWizard = require("./utils/setupWizard");
const setup = require("./utils/setup");
const fs = require("fs");
const cleanEmailThread = require('./utils/cleanEmailThread');

// Move service requires inside functions to prevent early initialization
let emailService, aiService;

async function loadServices() {
  try {
    emailService = require("./services/emailService");
    aiService = require("./services/aiService");
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

async function processEmails() {
  try {
    logger.info("Starting email fetch");
    await loadServices();
    
    // Initialize Gmail service
    await emailService.initialize();
    logger.info("Email service initialized");

    // Fetch email threads
    let threads = await emailService.fetchEmailThreads(500);


    logger.info(`Found ${threads.length} threads`);

    // Deduplicate threads by threadId, keeping the first occurrence
    const seenThreadIds = new Set();
    let uniqueThreads = threads.filter(thread => {
      if (seenThreadIds.has(thread.threadId)) {
        return false;
      }
      seenThreadIds.add(thread.threadId);
      return true;
    });

    logger.info(`After deduplication: ${uniqueThreads.length} unique threads`);
    
    // reverse threads
    uniqueThreads = uniqueThreads.reverse();
    
    // Download full content for each thread
    // const threadContents = [];

    let allOpenAIMessages = []

    for (const thread of uniqueThreads) {
      if (thread) {

        const content = await emailService.downloadThreadContent(thread.threadId);
        if (!content.hasMyMessage && !content.needsReply) continue;

        // console.log("thread content", content);
        console.log(`\nProcessing thread ${thread.threadId}...`);
        console.log(`Subject: ${content.subject}`);
        // Pass just the messages array to cleanEmailThread
        const cleanedMessages = cleanEmailThread(content.messages);
  
        // Create new thread object with cleaned messages
        // const cleanedContent = {
        //   ...content,
        //   messages: cleanedMessages
        // };
        // threadContents.push(cleanedContent);
        
        let openAIMessages = [];
        for (const message of cleanedMessages) {
          const openAIMessage = {
            "role": message.senderIsMe ? "assistant" : "user",
            "content": formatAIMessageBody(message)
          }
          openAIMessages.push(openAIMessage);
        }

        if (content.needsReply) { 
          const shouldReply = await aiService.analyzeEmail(openAIMessages);

          allOpenAIMessages = [...allOpenAIMessages, ...openAIMessages];
          
          console.log('----------------------------------------');
          if (shouldReply) {
            // console.log('Needs reply!!!', openAIMessages);
            const reply = await aiService.respondToEmail(openAIMessages);
            console.log('Reply:', reply);
            
            // Create a draft with the AI's response
            const lastMessage = cleanedMessages[cleanedMessages.length - 1];
            await emailService.createDraft(thread.threadId, {
              to: lastMessage.from,
              subject: lastMessage.subject,
              messageId: lastMessage.messageId,
              references: lastMessage.references,
              body: reply
            });

            allOpenAIMessages.push({
              "role": "assistant",
              "content": reply
            });
            
            // Mark the last message as read
            await emailService.markMessageAsRead(content.messages[content.messages.length - 1].id);
          }
        } 
      }
    }

    // Log summary of downloaded threads
    logger.info(`Successfully downloaded ${allOpenAIMessages.length} threads`);
    console.log('----------------------------------------');


    // fs.writeFileSync('emails_cleaned.json', JSON.stringify(threadContents, null, 2));
    // return threadContents;
  } catch (error) {
    console.error("Error processing emails:", error);
    logger.error("Error processing emails", { error: error.message });
  }
}

function formatAIMessageBody(message) {
  return `
Subject: ${message.subject}
From: ${message.from}
To: ${message.to}
Date: ${message.date}

${message.body}
`;
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

    // Start the email processing
    await processEmails();
    
    process.exit(0);

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
