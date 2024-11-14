const { ChatOpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const config = require("../config/config");
const emailService = require("./emailService");
const logger = require("../utils/logger");
const { encode } = require("gpt-3-encoder");

class SummaryService {
  constructor() {
    this.model = new ChatOpenAI({
      openAIApiKey: config.openai.apiKey,
      temperature: 0.7,
      modelName: "gpt-4-turbo-preview",
    });
  }

  async generateHourlySummary(type = "normal") {
    try {
      // Get time range based on summary type
      const timeRange = this.getTimeRange(type);
      
      // Fetch emails within the time range
      const emails = await emailService.fetchEmailsInRange(
        timeRange.startTime,
        timeRange.endTime
      );

      if (!emails.length) {
        return "No emails found in the selected time range.";
      }

      logger.info(`Generating summary for ${emails.length} emails`);

      // Generate summary using batched processing if needed
      const summary = await this.generateSummaryForEmails(emails);

      return this.formatSummaryResponse(summary, timeRange, emails.length);
    } catch (error) {
      logger.error("Error generating summary", { error: error.message });
      return `Error generating summary: ${error.message}`;
    }
  }

  getTimeRange(type) {
    const now = new Date();
    let startTime = new Date();
    
    switch (type) {
      case "morning": // Overnight (5 PM yesterday to now)
        startTime.setDate(startTime.getDate() - 1);
        startTime.setHours(17, 0, 0, 0);
        break;
      
      case "midday": // Since 9 AM
        startTime.setHours(9, 0, 0, 0);
        break;
      
      case "evening": // Since 2 PM
        startTime.setHours(14, 0, 0, 0);
        break;
      
      case "quick": // Last 3 hours
        startTime.setHours(now.getHours() - 3);
        break;
      
      default: // Last 24 hours
        startTime.setHours(now.getHours() - 24);
    }

    return {
      startTime,
      endTime: now,
      type
    };
  }

  async generateSummaryForEmails(emails) {
    // Prepare the email data for the prompt
    const emailData = emails.map(email => ({
      subject: email.subject || 'No Subject',
      from: email.from || 'Unknown Sender',
      date: email.date || new Date().toISOString(),
      priority: this.calculatePriority(email)
    }));

    const prompt = PromptTemplate.fromTemplate(`
Summarize these emails concisely and highlight important items:

Emails:
{emails}

Provide a summary that:
1. Highlights urgent or important emails first
2. Groups similar topics together
3. Lists any required actions
4. Identifies key trends or patterns

Format:
🚨 URGENT/IMPORTANT:
[List urgent items]

📥 KEY UPDATES:
[Group by topic/sender]

⚡️ ACTIONS NEEDED:
[List required actions]

📊 INSIGHTS:
[Any patterns or trends]`);

    const formattedEmails = emailData
      .map(email => `From: ${email.from}\nSubject: ${email.subject}\nPriority: ${email.priority}`)
      .join('\n\n');

    const response = await this.model.invoke(
      await prompt.format({ emails: formattedEmails })
    );

    return response.content;
  }

  calculatePriority(email) {
    // Simple priority calculation based on sender and subject keywords
    const priorityKeywords = ['urgent', 'asap', 'important', 'deadline', 'critical'];
    const subject = email.subject?.toLowerCase() || '';
    
    if (priorityKeywords.some(keyword => subject.includes(keyword))) {
      return 'High';
    }
    
    // Add more sophisticated priority logic here if needed
    return 'Normal';
  }

  formatSummaryResponse(summary, timeRange, emailCount) {
    const timeRangeStr = this.formatTimeRange(timeRange);
    
    return `📧 Email Summary (${timeRangeStr})
Total Emails: ${emailCount}

${summary}

Use /process to start processing these emails.`;
  }

  formatTimeRange(timeRange) {
    const formatTime = (date) => {
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    };

    const formatDate = (date) => {
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      });
    };

    const start = formatTime(timeRange.startTime);
    const end = formatTime(timeRange.endTime);
    const startDate = formatDate(timeRange.startTime);
    const endDate = formatDate(timeRange.endTime);

    if (startDate === endDate) {
      return `${startDate}, ${start} - ${end}`;
    }
    
    return `${startDate} ${start} - ${endDate} ${end}`;
  }
}

module.exports = new SummaryService();
