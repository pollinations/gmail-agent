const TelegramBot = require("node-telegram-bot-api");
const config = require("../config/config");
const logger = require("../utils/logger");
const emailService = require("./emailService");
const aiService = require("./aiService");
const summaryService = require("./summaryService");
const cron = require("node-cron");
const { processEmails } = require("../index");

class TelegramService {
  constructor() {
    this.bot = null;
    this.pendingConfirmations = new Map();
    this.editingResponses = new Map();
    this.isProcessing = false;
    this.processLoop = null;
  }

  async initialize() {
    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: true });

      // Register command handlers
      this.bot.onText(/\/summary/, this.handleSummaryCommand.bind(this));
      this.bot.onText(/\/process/, this.handleProcessCommand.bind(this));
      this.bot.onText(/\/stop/, this.handleStopCommand.bind(this));
      this.bot.onText(/\/help/, this.handleHelpCommand.bind(this));

      // Register callback query handler
      this.bot.on("callback_query", this.handleCallbackQuery.bind(this));

      // Register general message handler
      this.bot.on("message", this.handleIncomingMessage.bind(this));

      // Schedule summaries during work hours only (more frequent but less resource intensive)
      cron.schedule("0,30 9-18 * * 1-5", () => { // Every 30 minutes during work hours on weekdays
        this.sendScheduledSummary("short");
      });

      // Weekly summary on Monday morning
      cron.schedule("0 9 * * 1", () => {
        this.sendScheduledSummary("normal");
      });

      // Monthly overview (kept as is since it's already minimal)
      cron.schedule("0 9 1 * *", () => {
        this.sendScheduledSummary("long");
      });

      logger.info("Telegram bot initialized with scheduled summaries");
    } catch (error) {
      logger.error("Failed to initialize Telegram bot", {
        error: error.message,
      });
      throw error;
    }
  }

  async handleSummaryCommand(msg) {
    try {
      // Verify user authorization
      if (msg.from.id.toString() !== config.telegram.userId) {
        logger.warn(`Unauthorized summary request from user ${msg.from.id}`);
        return;
      }

      await this.bot.sendMessage(msg.chat.id, "📊 Choose summary range:", {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📊 Last 4 Days", callback_data: "summary_short" },
              { text: "📈 Last 2 Weeks", callback_data: "summary_normal" },
            ],
            [
              { text: "📚 Last 3 Months", callback_data: "summary_long" },
            ],
          ],
        },
      });
    } catch (error) {
      logger.error("Error handling summary command", { error: error.message });
      await this.sendErrorMessage(msg.chat.id);
    }
  }

  async handleHelpCommand(msg) {
    try {
      const helpMessage = `
📧 *Gmail Agent Help*

Commands:
/summary \- Request an email summary
/process \- Start processing emails
/stop \- Stop email processing
/help \- Show this help message

*Summary Types:*
• Morning Overview \(9 AM\)
• Midday Catch\-up \(2 PM\)
• Evening Wrap\-up \(7 PM\)

*Each Summary Includes:*
• Overview of important emails
• Top 5 priority items
• Key insights

*Note:* Summaries automatically run at scheduled times\. Use /summary for an immediate report\.`;

      await this.bot.sendMessage(msg.chat.id, helpMessage, {
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      });
    } catch (error) {
      logger.error("Error sending help message", {
        error: error.message,
        userId: msg.from.id,
      });
      // Send a plain text fallback message if markdown fails
      try {
        const fallbackMessage = `
📧 Gmail Agent Help

Commands:
/summary - Request an email summary
/process - Start processing emails
/stop - Stop email processing
/help - Show this help message

Summary Types:
• Morning Overview (9 AM)
• Midday Catch-up (2 PM)
• Evening Wrap-up (7 PM)

Each Summary Includes:
• Overview of important emails
• Top 5 priority items
• Key insights

Note: Summaries automatically run at scheduled times. Use /summary for an immediate report.`;

        await this.bot.sendMessage(msg.chat.id, fallbackMessage);
      } catch (fallbackError) {
        logger.error("Error sending fallback help message", {
          error: fallbackError.message,
          userId: msg.from.id,
        });
        await this.sendErrorMessage(msg.chat.id);
      }
    }
  }

  // Add callback query handler for summary buttons
  async handleCallbackQuery(callbackQuery) {
    try {
      const userId = callbackQuery.from.id.toString();
      if (userId !== config.telegram.userId) {
        logger.warn(`Unauthorized callback query from user ${userId}`);
        return;
      }

      const action = callbackQuery.data;
      if (action.startsWith("summary_")) {
        const summaryType = action.split("_")[1];
        await this.bot.sendMessage(
          callbackQuery.message.chat.id,
          `Generating ${summaryType} summary...`
        );

        // Override the summary type temporarily
        const originalGetSummaryType = summaryService.getSummaryType;
        summaryService.getSummaryType = () => summaryType;

        // Generate and send the summary
        const summary = await summaryService.generateHourlySummary();

        // Restore the original method
        summaryService.getSummaryType = originalGetSummaryType;

        if (summary.startsWith("Error generating summary:")) {
          logger.error("Summary generation failed", { summary });
          await this.bot.sendMessage(
            callbackQuery.message.chat.id,
            "An error occurred while generating the summary. Please try again later or contact support."
          );
        } else {
          await this.bot.sendMessage(callbackQuery.message.chat.id, summary);
        }
      }

      // Answer the callback query to remove the loading state
      await this.bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
      logger.error("Error handling callback query", {
        error: error.message,
        stack: error.stack,
      });
      console.error(error);
      await this.sendErrorMessage(callbackQuery.message.chat.id);
    }
  }

  async handleIncomingMessage(msg) {
    try {
      // Only process messages from authorized user
      if (msg.from.id.toString() !== config.telegram.userId) {
        logger.warn(`Unauthorized message from user ${msg.from.id}`);
        return;
      }

      const confirmationData = this.pendingConfirmations.get(msg.from.id);
      if (!confirmationData) {
        logger.warn(`No pending confirmation found for user ${msg.from.id}`);
        return;
      }

      // Handle bulk mark as read confirmation
      if (confirmationData.type === "bulkMarkAsRead") {
        await this.handleBulkMarkAsRead(msg.from.id, msg.text, confirmationData);
        return;
      }

      // Handle follow-up questions
      if (confirmationData.type === "followUp") {
        await this.handleFollowUpResponse(msg, confirmationData);
        return;
      }

      // Handle bulk archive confirmation
      if (confirmationData.type === "bulkArchive") {
        await this.handleBulkArchive(msg.from.id, msg.text, confirmationData);
        return;
      }

      const {
        emailId,
        action,
        draftResponse,
        originalEmail,
        editHistory = [],
      } = confirmationData;

      // Handle editing mode
      if (this.editingResponses.has(msg.from.id)) {
        await this.handleEditingResponse(msg, confirmationData);
        return;
      }

      await this.handleActionResponse(msg, confirmationData);
    } catch (error) {
      logger.error("Error handling incoming message", {
        error: error.message,
        userId: msg.from.id,
        messageText: msg.text,
      });
      await this.sendErrorMessage(msg.from.id);
    }
  }

  async handleFollowUpResponse(msg, confirmationData) {
    try {
      const { email, question, questionIndex, totalQuestions } =
        confirmationData;

      // Process the answer
      await aiService.processUserResponse(email, question, msg.text);

      if (questionIndex < totalQuestions.length - 1) {
        // More questions to ask
        await this.sendNextQuestion(
          msg.from.id,
          email,
          questionIndex + 1,
          totalQuestions
        );
      } else {
        // All questions answered, proceed with email analysis
        const analysis = await aiService.analyzeEmail(email);
        await this.sendConfirmation(msg.from.id, email, analysis);
      }
    } catch (error) {
      logger.error("Error handling follow-up response", {
        error: error.message,
      });
      await this.sendErrorMessage(msg.from.id);
    }
  }

  async handleEditingResponse(msg, confirmationData) {
    try {
      const {
        emailId,
        action,
        draftResponse,
        originalEmail,
        editHistory = [],
      } = confirmationData;

      editHistory.push({
        timestamp: new Date().toISOString(),
        content: msg.text,
      });

      const refinedResponse = await aiService.refineResponse(
        originalEmail,
        draftResponse,
        msg.text,
        editHistory
      );

      confirmationData.draftResponse = refinedResponse;
      confirmationData.editHistory = editHistory;

      this.editingResponses.delete(msg.from.id);
      await this.sendFinalConfirmationWithHistory(
        msg.from.id,
        confirmationData
      );
    } catch (error) {
      logger.error("Error handling editing response", { error: error.message });
      await this.sendErrorMessage(msg.from.id);
    }
  }

  async handleActionResponse(msg, confirmationData) {
    try {
      const { emailId, action, draftResponse, originalEmail } = confirmationData;

      switch (msg.text) {
        case "1":
          await this.executeConfirmedAction(msg.from.id, confirmationData);
          break;

        case "2":
          await this.bot.sendMessage(
            msg.from.id,
            "✅ Action cancelled. The email will remain unread."
          );
          this.pendingConfirmations.delete(msg.from.id);
          break;

        case "3":
          if (action === "RESPOND") {
            await this.initiateEditing(msg.from.id, confirmationData);
          } else {
            await this.handleForceReply(msg.from.id, confirmationData);
          }
          break;

        case "4":
          if (action === "RESPOND") {
            await this.handleForceArchive(msg.from.id, emailId);
          } else {
            await this.handleMarkAsRead(msg.from.id, emailId);
          }
          break;

        case "5":
          if (action === "RESPOND") {
            await this.handleMarkAsRead(msg.from.id, emailId);
          }
          break;

        default:
          logger.warn(`Unexpected response: ${msg.text}`);
          await this.sendErrorMessage(msg.from.id);
      }
    } catch (error) {
      logger.error("Error handling action response", {
        error: error.message,
        userId: msg.from.id,
        action: confirmationData?.action,
      });
      await this.sendErrorMessage(msg.from.id);
    }
  }

  async executeConfirmedAction(userId, confirmationData) {
    try {
      const { emailId, action, draftResponse, originalEmail } = confirmationData;

      if (!emailId || !action) {
        logger.error("Invalid confirmation data", { confirmationData });
        await this.sendErrorMessage(userId);
        this.pendingConfirmations.delete(userId);
        return;
      }

      switch (action) {
        case "RESPOND":
          if (!draftResponse) {
            logger.error("Missing draft response for RESPOND action");
            await this.sendErrorMessage(userId);
            break;
          }
          await emailService.sendResponse(emailId, draftResponse);
          await this.bot.sendMessage(userId, "✅ Response sent successfully!");
          
          // Ensure email is marked as processed
          emailService.markAsProcessed(emailId);
          break;

        case "ARCHIVE":
          try {
            // Check for similar emails before archiving
            const similarEmails = await emailService.findSimilarEmails(
              originalEmail
            );

            if (similarEmails && similarEmails.length > 0) {
              await this.askBulkArchiveConfirmation(
                userId,
                similarEmails,
                emailId,
                originalEmail
              );
              return; // Don't clear confirmation yet
            }

            await emailService.archiveEmail(emailId);
            await this.bot.sendMessage(
              userId,
              "✅ Email archived successfully!"
            );
          } catch (archiveError) {
            logger.error("Error in archive operation", {
              error: archiveError.message,
              emailId,
            });
            await this.sendErrorMessage(userId);
          }
          break;

        default:
          logger.warn(`Unknown action: ${action}`);
          await this.sendErrorMessage(userId);
          break;
      }

      // Clear the pending confirmation after successful execution
      this.pendingConfirmations.delete(userId);
    } catch (error) {
      logger.error("Error executing confirmed action", {
        error: error.message,
        userId,
        emailId: confirmationData?.emailId,
        action: confirmationData?.action,
      });
      await this.sendErrorMessage(userId);
      // Clean up the pending confirmation on error
      this.pendingConfirmations.delete(userId);
    }
  }

  async sendErrorMessage(userId) {
    try {
      await this.bot.sendMessage(
        userId,
        "❌ An error occurred. Please try again or contact support."
      );
    } catch (error) {
      logger.error("Error sending error message", { error: error.message });
    }
  }

  escapeSpecialChars(text) {
    if (!text) return "";
    return text
      .replace(/\\/g, "\\\\")
      .replace(/\./g, "\\.")
      .replace(/\!/g, "\\!")
      .replace(/\_/g, "\\_")
      .replace(/\*/g, "\\*")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/\~/g, "\\~")
      .replace(/\`/g, "\\`")
      .replace(/\>/g, "\\>")
      .replace(/\#/g, "\\#")
      .replace(/\+/g, "\\+")
      .replace(/\-/g, "\\-")
      .replace(/\=/g, "\\=")
      .replace(/\|/g, "\\|")
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/\&/g, "\\&");
  }

  async sendEditHistory(userId, editHistory) {
    let message = "*Edit History:*\n\n";
    editHistory.forEach((edit, index) => {
      const timestamp = new Date(edit.timestamp).toLocaleTimeString();
      message += `Edit ${index + 1} (${timestamp}):\n${this.escapeSpecialChars(
        edit.content
      )}\n\n`;
    });

    await this.bot.sendMessage(userId, message, {
      parse_mode: "Markdown",
    });
  }

  async sendFinalConfirmationWithHistory(userId, confirmationData) {
    try {
      const { draftResponse, editHistory } = confirmationData;

      let message = `
📧 *Confirm Final Response*

*Current Response:*
${this.escapeSpecialChars(draftResponse)}

${editHistory.length > 0 ? "\n*Edit History:*" : ""}
${editHistory
  .map((edit, index) => {
    const timestamp = new Date(edit.timestamp).toLocaleTimeString();
    return `\nEdit ${index + 1} (${timestamp}):\n${this.escapeSpecialChars(
      edit.content
    )}`;
  })
  .join("\n")}

Reply with:
1️⃣ to Confirm and Send
2️⃣ to Cancel
3️⃣ to Edit Again`;

      await this.bot.sendMessage(userId, message, {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [["1", "2", "3"]],
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });
    } catch (error) {
      logger.error("Error sending final confirmation", {
        error: error.message,
        userId,
      });
      await this.sendErrorMessage(userId);
    }
  }

  async sendConfirmation(userId, emailData, analysis) {
    try {
      if (analysis.action === "NEED_INFO") {
        logger.info(`Additional information needed for email ${emailData.id}`);
        await this.sendNextQuestion(userId, emailData, 0, analysis.questions);
        return;
      }

      const summary = await aiService.summarizeThread(emailData);
      const message = `📧 *New Email Action Required*

*Subject:* ${this.escapeSpecialChars(emailData.subject || "No Subject")}
*From:* ${this.escapeSpecialChars(emailData.from || "Unknown")}

*Thread Summary:*
${this.escapeSpecialChars(summary)}

*Suggested Action:* ${this.escapeSpecialChars(analysis.action)}
*Reason:* ${this.escapeSpecialChars(analysis.reason)}

${
  analysis.action === "RESPOND"
    ? `*Proposed Response:*\n${this.escapeSpecialChars(analysis.draftResponse)}`
    : ""
}

Reply with:
1️⃣ to Confirm
2️⃣ to Reject
${analysis.action === "RESPOND" 
  ? "3️⃣ to Edit Response\n4️⃣ to Force Archive\n5️⃣ to Mark as Read" 
  : "3️⃣ to Force Reply\n4️⃣ to Mark as Read"}`;

      const keyboard = analysis.action === "RESPOND" 
        ? [["1", "2", "3", "4", "5"]]
        : [["1", "2", "3", "4"]];

      await this.bot.sendMessage(userId, message, {
        parse_mode: "MarkdownV2",
        reply_markup: {
          keyboard: keyboard,
          one_time_keyboard: true,
          resize_keyboard: true,
        },
      });

      this.pendingConfirmations.set(parseInt(userId), {
        emailId: emailData.id,
        action: analysis.action,
        draftResponse: analysis.draftResponse,
        originalEmail: emailData,
        editHistory: [],
      });

      logger.info(`Confirmation request sent for email ${emailData.id}`);
    } catch (error) {
      logger.error("Error sending confirmation", {
        error: error.message,
        userId,
        emailId: emailData?.id,
      });
      await this.sendErrorMessage(userId);
    }
  }

  async askBulkArchiveConfirmation(
    userId,
    similarEmails,
    originalEmailId,
    originalEmail
  ) {
    try {
      // Limit the number of similar emails shown
      const displayEmails = similarEmails.slice(0, 5); // Reduced to 5 for better formatting
      const totalCount = similarEmails.length;

      // Build message in parts to better control length
      const header = `📧 *Similar Emails Found*\n\nFound ${totalCount} similar emails${
        totalCount > 5 ? " (showing first 5)" : ""
      }\\.`;

      const originalSection = `\n\n*Original Email:*\nFrom: ${this.escapeSpecialChars(
        originalEmail.from
      )}\nSubject: ${this.escapeSpecialChars(originalEmail.subject)}`;

      // Build similar emails section with better formatting
      const similarSection = displayEmails
        .map(
          (email, index) =>
            `${index + 1}\\. *From:* ${this.escapeSpecialChars(
              email.from
            )}\n    *Subject:* ${this.escapeSpecialChars(email.subject)}`
        )
        .join("\n\n");

      const footer = `\n\nReply with:\n1️⃣ to Archive All \\(${totalCount} emails\\)\n2️⃣ to Archive Original Only\n3️⃣ to Select Individual Emails`;

      // Combine all parts
      const message = `${header}${originalSection}\n\n*Similar Emails:*\n${similarSection}${footer}`;

      // Send with proper error handling
      try {
        await this.bot.sendMessage(userId, message, {
          parse_mode: "MarkdownV2",
          reply_markup: {
            keyboard: [["1", "2", "3"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        });
      } catch (sendError) {
        // If the formatted message fails, try sending a simplified version
        const fallbackMessage = `📧 Similar Emails Found\n\nFound ${totalCount} similar emails. Would you like to archive them all?\n\n1️⃣ Archive All\n2️⃣ Archive Original Only\n3️⃣ Select Individual Emails`;

        await this.bot.sendMessage(userId, fallbackMessage, {
          reply_markup: {
            keyboard: [["1", "2", "3"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        });
      }

      // Store the confirmation data
      this.pendingConfirmations.set(parseInt(userId), {
        type: "bulkArchive",
        originalEmailId,
        originalEmail,
        similarEmails, // Store all emails for later use
      });
    } catch (error) {
      logger.error("Error sending bulk archive confirmation", {
        error: error.message,
        userId,
        emailCount: similarEmails?.length,
      });

      // Send a very simple fallback message
      await this.bot.sendMessage(
        userId,
        "Similar emails found. Reply:\n1 - Archive All\n2 - Archive Original\n3 - Select Individual",
        {
          reply_markup: {
            keyboard: [["1", "2", "3"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );

      // Still store the confirmation data
      this.pendingConfirmations.set(parseInt(userId), {
        type: "bulkArchive",
        originalEmailId,
        originalEmail,
        similarEmails,
      });
    }
  }

  async handleBulkArchive(userId, choice, confirmationData) {
    try {
      const { originalEmailId, similarEmails } = confirmationData;

      switch (choice) {
        case "1":
          // Archive all emails
          const allEmailIds = [
            originalEmailId,
            ...similarEmails.map((email) => email.id),
          ];

          logger.info(`Bulk archiving ${allEmailIds.length} emails`);
          const results = await emailService.bulkArchive(allEmailIds);

          const successCount = results.filter((r) => r.success).length;
          await this.bot.sendMessage(
            userId,
            `✅ Successfully archived ${successCount} emails!`
          );
          break;

        case "2":
          // Archive only original email
          logger.info(`Archiving only original email ${originalEmailId}`);
          await emailService.archiveEmail(originalEmailId);
          await this.bot.sendMessage(
            userId,
            "✅ Original email archived successfully!"
          );
          break;

        case "3":
          // Show individual selection interface
          await this.showEmailSelectionInterface(userId, confirmationData);
          return; // Don't clear pending confirmations yet

        default:
          logger.warn(`Unexpected bulk archive choice: ${choice}`);
          await this.sendErrorMessage(userId);
      }

      // Clear pending confirmations
      this.pendingConfirmations.delete(userId);
    } catch (error) {
      logger.error(`Error in bulk archive operation`, { error: error.message });
      await this.sendErrorMessage(userId);
      this.pendingConfirmations.delete(userId);
    }
  }

  async showEmailSelectionInterface(userId, confirmationData) {
    try {
      const { similarEmails } = confirmationData;
      const displayEmails = similarEmails.slice(0, 20);

      const message = `Select emails to archive \\(send numbers separated by commas\\):

${displayEmails
  .map(
    (email, index) =>
      `${index + 1}\\. From: ${this.escapeSpecialChars(email.from)}
Subject: ${this.escapeSpecialChars(email.subject)}`
  )
  .join("\n\n")}

Example: 1,3,4 to select those emails
Or type 'cancel' to abort${
        similarEmails.length > 20 ? "\n(Showing first 20 emails)" : ""
      }`;

      await this.bot.sendMessage(userId, message, {
        parse_mode: "MarkdownV2",
        reply_markup: {
          force_reply: true,
          remove_keyboard: true,
        },
      });

      confirmationData.type = "emailSelection";
      this.pendingConfirmations.set(userId, confirmationData);
    } catch (error) {
      logger.error("Error showing email selection interface", {
        error: error.message,
        userId,
      });
      await this.sendErrorMessage(userId);
      this.pendingConfirmations.delete(userId);
    }
  }

  clearPendingConfirmationsForEmails(emailIds) {
    // Clear any pending confirmations for the archived emails
    for (const [userId, confirmation] of this.pendingConfirmations.entries()) {
      if (confirmation.emailId && emailIds.includes(confirmation.emailId)) {
        this.pendingConfirmations.delete(userId);
      }
    }
  }

  async sendNextQuestion(userId, email, questionIndex, questions) {
    const message = `
❓ Additional Information Needed (${questionIndex + 1}/${questions.length})

${questions[questionIndex]}

Please provide your answer:`;

    await this.bot.sendMessage(userId, message, {
      reply_markup: {
        force_reply: true,
        remove_keyboard: true,
      },
    });

    // Store the question context
    this.pendingConfirmations.set(parseInt(userId), {
      type: "followUp",
      email,
      question: questions[questionIndex],
      questionIndex,
      totalQuestions: questions,
    });
  }

  async sendScheduledSummary(type = "normal") {
    try {
      const currentTime = new Date();
      logger.info(
        `Scheduled ${type} summary triggered at ${currentTime.toLocaleTimeString()}`
      );
      const summary = await summaryService.generateHourlySummary(type);
      await this.bot.sendMessage(config.telegram.userId, summary);
      logger.info(`Scheduled ${type} summary sent successfully`);
    } catch (error) {
      logger.error("Error sending scheduled summary", { error: error.message });
    }
  }

  async initiateEditing(userId, confirmationData) {
    try {
      // Create a simpler message with properly escaped characters
      const escapedResponse = this.escapeSpecialChars(
        confirmationData.draftResponse || ""
      );

      const message = [
        "📝 *Current Response:*",
        "",
        escapedResponse,
        "",
        "Please send your edited version\\.",
      ].join("\n");

      await this.bot.sendMessage(userId, message, {
        parse_mode: "MarkdownV2",
        reply_markup: {
          force_reply: true,
          remove_keyboard: true,
        },
      });

      this.editingResponses.set(userId, true);
    } catch (error) {
      logger.error("Error initiating editing", {
        error: error.message,
        userId,
        responseLength: confirmationData?.draftResponse?.length,
      });

      // Send a plain text fallback if markdown fails
      try {
        await this.bot.sendMessage(
          userId,
          "📝 Current Response:\n\n" +
            (confirmationData.draftResponse || "") +
            "\n\nPlease send your edited version.",
          {
            reply_markup: {
              force_reply: true,
              remove_keyboard: true,
            },
          }
        );
        this.editingResponses.set(userId, true);
      } catch (fallbackError) {
        logger.error("Error sending fallback edit message", {
          error: fallbackError.message,
        });
        await this.sendErrorMessage(userId);
        this.editingResponses.delete(userId);
      }
    }
  }

  async handleForceReply(userId, confirmationData) {
    try {
      const forcedResponse = await aiService.generateForcedResponse(
        confirmationData.originalEmail
      );
      confirmationData.action = "RESPOND";
      confirmationData.draftResponse = forcedResponse;
      await this.sendFinalConfirmationWithHistory(userId, confirmationData);
    } catch (error) {
      logger.error("Error handling force reply", { error: error.message });
      await this.sendErrorMessage(userId);
    }
  }

  async handleForceArchive(userId, emailId) {
    try {
      await emailService.archiveEmail(emailId);
      await this.bot.sendMessage(userId, "✅ Email archived successfully!");
      this.pendingConfirmations.delete(userId);
    } catch (error) {
      logger.error("Error handling force archive", { error: error.message });
      await this.sendErrorMessage(userId);
    }
  }

  async handleMarkAsRead(userId, emailId) {
    try {
      // Check for similar emails before marking as read
      const confirmationData = this.pendingConfirmations.get(parseInt(userId));
      const originalEmail = confirmationData?.originalEmail;

      if (originalEmail) {
        const similarEmails = await emailService.findSimilarEmails(originalEmail);

        if (similarEmails && similarEmails.length > 0) {
          await this.askBulkMarkAsReadConfirmation(
            userId,
            similarEmails,
            emailId,
            originalEmail
          );
          return; // Don't clear confirmation yet
        }
      }

      await emailService.markAsRead(emailId);
      await this.bot.sendMessage(userId, "✅ Email marked as read!");
      this.pendingConfirmations.delete(userId);
    } catch (error) {
      logger.error("Error marking email as read", { error: error.message });
      await this.sendErrorMessage(userId);
    }
  }

  async askBulkMarkAsReadConfirmation(userId, similarEmails, originalEmailId, originalEmail) {
    try {
      // Limit the number of similar emails shown
      const displayEmails = similarEmails.slice(0, 5);
      const totalCount = similarEmails.length;

      const header = `📧 *Similar Emails Found*\n\nFound ${totalCount} similar emails${
        totalCount > 5 ? " (showing first 5)" : ""
      }\\.`;

      const originalSection = `\n\n*Original Email:*\nFrom: ${this.escapeSpecialChars(
        originalEmail.from
      )}\nSubject: ${this.escapeSpecialChars(originalEmail.subject)}`;

      const similarSection = displayEmails
        .map(
          (email, index) =>
            `${index + 1}\\. *From:* ${this.escapeSpecialChars(
              email.from
            )}\n    *Subject:* ${this.escapeSpecialChars(email.subject)}`
        )
        .join("\n\n");

      const footer = `\n\nReply with:\n1️⃣ to Mark All as Read \\(${totalCount} emails\\)\n2️⃣ to Mark Original Only\n3️⃣ to Select Individual Emails`;

      const message = `${header}${originalSection}\n\n*Similar Emails:*\n${similarSection}${footer}`;

      try {
        await this.bot.sendMessage(userId, message, {
          parse_mode: "MarkdownV2",
          reply_markup: {
            keyboard: [["1", "2", "3"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        });
      } catch (sendError) {
        // Fallback to simpler message if formatting fails
        const fallbackMessage = `📧 Similar Emails Found\n\nFound ${totalCount} similar emails. Would you like to mark them all as read?\n\n1️⃣ Mark All as Read\n2️⃣ Mark Original Only\n3️⃣ Select Individual Emails`;

        await this.bot.sendMessage(userId, fallbackMessage, {
          reply_markup: {
            keyboard: [["1", "2", "3"]],
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        });
      }

      // Store the confirmation data
      this.pendingConfirmations.set(parseInt(userId), {
        type: "bulkMarkAsRead",
        originalEmailId,
        originalEmail,
        similarEmails,
      });
    } catch (error) {
      logger.error("Error sending bulk mark as read confirmation", {
        error: error.message,
        userId,
        emailCount: similarEmails?.length,
      });
      await this.sendErrorMessage(userId);
    }
  }

  async handleBulkMarkAsRead(userId, choice, confirmationData) {
    try {
      const { originalEmailId, similarEmails } = confirmationData;

      switch (choice) {
        case "1":
          // Mark all emails as read
          const allEmailIds = [
            originalEmailId,
            ...similarEmails.map((email) => email.id),
          ];

          logger.info(`Bulk marking ${allEmailIds.length} emails as read`);
          const results = await emailService.bulkMarkAsRead(allEmailIds);

          const successCount = results.filter((r) => r.success).length;
          await this.bot.sendMessage(
            userId,
            `✅ Successfully marked ${successCount} emails as read!`
          );
          break;

        case "2":
          // Mark only original email as read
          logger.info(`Marking only original email ${originalEmailId} as read`);
          await emailService.markAsRead(originalEmailId);
          await this.bot.sendMessage(
            userId,
            "✅ Original email marked as read!"
          );
          break;

        case "3":
          // Show individual selection interface
          await this.showEmailSelectionInterface(userId, {
            ...confirmationData,
            action: "markAsRead"
          });
          return; // Don't clear pending confirmations yet

        default:
          logger.warn(`Unexpected bulk mark as read choice: ${choice}`);
          await this.sendErrorMessage(userId);
      }

      // Clear pending confirmations
      this.pendingConfirmations.delete(userId);
    } catch (error) {
      logger.error(`Error in bulk mark as read operation`, { error: error.message });
      await this.sendErrorMessage(userId);
      this.pendingConfirmations.delete(userId);
    }
  }

  // Add new command handler for processing emails
  async handleProcessCommand(msg) {
    try {
      // Verify user authorization
      if (msg.from.id.toString() !== config.telegram.userId) {
        logger.warn(`Unauthorized process request from user ${msg.from.id}`);
        return;
      }

      if (this.isProcessing) {
        await this.bot.sendMessage(
          msg.chat.id,
          "📧 Email processing is already running. Use /stop to stop it first."
        );
        return;
      }

      this.isProcessing = true;
      await this.bot.sendMessage(msg.chat.id, "📧 Starting email processing...");

      try {
        // Do initial processing
        await processEmails();

        // Start the processing loop
        this.processLoop = setInterval(async () => {
          if (!this.pendingConfirmations.has(parseInt(config.telegram.userId))) {
            await processEmails();
          }
        }, 60 * 1000);
      } catch (error) {
        this.isProcessing = false;
        if (this.processLoop) {
          clearInterval(this.processLoop);
          this.processLoop = null;
        }
        throw error;
      }
    } catch (error) {
      logger.error("Error handling process command", { error: error.message });
      await this.sendErrorMessage(msg.chat.id);
    }
  }

  // Add stop command handler
  async handleStopCommand(msg) {
    try {
      // Verify user authorization
      if (msg.from.id.toString() !== config.telegram.userId) {
        logger.warn(`Unauthorized stop request from user ${msg.from.id}`);
        return;
      }

      if (!this.isProcessing) {
        await this.bot.sendMessage(
          msg.chat.id,
          "📧 Email processing is not currently running."
        );
        return;
      }

      // Clear the processing loop
      if (this.processLoop) {
        clearInterval(this.processLoop);
        this.processLoop = null;
      }
      this.isProcessing = false;

      await this.bot.sendMessage(msg.chat.id, "📧 Email processing stopped.");
    } catch (error) {
      logger.error("Error handling stop command", { error: error.message });
      await this.sendErrorMessage(msg.chat.id);
    }
  }
}

module.exports = new TelegramService();
