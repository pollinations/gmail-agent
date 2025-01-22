const config = require("./config/config");
const logger = require("./utils/logger");
const setupWizard = require("./utils/setupWizard");
const setup = require("./utils/setup");
const fs = require("fs");
const cleanEmailThread = require('./utils/cleanEmailThread');
const tqdm = require("tqdm");

const MUM_MESSAGE_HISTORY_TO_FETCH = 500;

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
    let threads = await emailService.fetchEmailThreads(MUM_MESSAGE_HISTORY_TO_FETCH);

    

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
    
    console.log("uniiqueThreads", uniqueThreads.map(t => t.messages[0]?.from));
    // Download full content for each thread
    // const threadContents = [];

    let allOpenAIMessages = []

    for (const thread of tqdm(uniqueThreads)) {
      try {
        if (thread) {

          const content = await emailService.downloadThreadContent(thread.threadId);
          console.log("from:", content.messages[0]?.from,"to:", content.messages[0]?.to,"subject:", content.subject, "hasMyMessage ",  content.hasMyMessage, "needsReply", content.needsReply);
          if (!content.hasMyMessage && !content.needsReply) continue;

          // console.log("thread content", content);
          console.log(`\nProcessing thread ${thread.threadId}...`);
          console.log(`Subject: ${content.subject} - From: ${content.messages[0].from}`);
          // Pass just the messages array to cleanEmailThread
          console.log("messages before clean", content.messges)
          const cleanedMessages = cleanEmailThread(content.messages);
    
          // Create new thread object with cleaned messages
          // const cleanedContent = {
          //   ...content,
          //   messages: cleanedMessages
          // };
          // threadContents.push(cleanedContent);
          
          console.log('----------------------------------------');
          console.log('Cleaned messages:', cleanedMessages.length);
          console.log('----------------------------------------');
          let openAIMessages = [];
          
          // Add thread separator message
          const participants = emailService.getAllThreadParticipants(cleanedMessages);
          openAIMessages.push({
            role: "user",
            content: `# NEW EMAIL THREAD WITH ID ${thread.threadId}\n--------------------------------------\n\n**Subject**: ${content.subject}\n**Participants**: ${participants.map(participant => participant.name).join(', ')}\n\nThe previous conversation and the following conversation are separate threads. They have no connection to each other unless by chance.\n`
          });

          // Process thread messages
          for (const message of cleanedMessages) {
            const openAIMessage = {
              "role": message.senderIsMe ? "assistant" : "user",
              "content": formatAIMessageBody(message)
            }
            // console.log(openAIMessage);
            openAIMessages.push(openAIMessage);
          }

          if (content.needsReply) { 
            const analysis = await aiService.analyzeEmail(openAIMessages);
            
            console.log('----------------------------------------');
            console.log('Analysis:', { analysis });
            console.log('----------------------------------------');
            
            if (analysis.respond) {

              // Search for background information
              const backgroundInfo = await aiService.searchBackgroundInformation(thread);
              console.log('Background information:', backgroundInfo);
              // process.exit(1);
              // console.log('Needs reply!!!', openAIMessages);
              allOpenAIMessages = [...allOpenAIMessages, ...openAIMessages];

              const reply = await aiService.respondToEmail([
                ...allOpenAIMessages, 
                { role: "user", "content": backgroundInfo, name: "getBackgroundInformation"  }
              ]);

              console.log('Reply:', reply);
              
              // Check if prompt tokens exceed 80,000 and remove first 10% of messages if needed
              if (aiService.lastUsage.prompt_tokens > 80000) {
                const messagesToRemove = Math.ceil(allOpenAIMessages.length * 0.1); // Calculate 10% of messages
                allOpenAIMessages.splice(0, messagesToRemove); // Remove first 10% of messages
                console.log(`Removed ${messagesToRemove} messages due to high token count`);
              }
              
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
              
              console.log('----------------------------------------');
              console.log(`Context size after adding reply: ${allOpenAIMessages.length} messages`);
              console.log('----------------------------------------');
              
              // Mark the last message as read
              await emailService.markMessageAsRead(content.messages[content.messages.length - 1].id);
            } else {
              if (content.hasMyMessage) {
                allOpenAIMessages = [...allOpenAIMessages, ...openAIMessages];
                console.log('----------------------------------------');
                console.log(`Context size after adding thread messages: ${allOpenAIMessages.length} messages`);
                console.log('----------------------------------------');
              }
            }
          } 
        }
      } catch (error) {
        console.error(`Error processing thread ${thread.threadId}:`, error);
        logger.error(`Error processing thread ${thread.threadId}`, { error: error.message });
        throw error;
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
    throw error;
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
