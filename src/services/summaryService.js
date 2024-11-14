const config = require("../config/config");
const emailService = require("./emailService");
const logger = require("../utils/logger");

class SummaryService {
  constructor() {
    this.apiEndpoint = "https://text.pollinations.ai/openai";
  }

  async callPollinationsAPI(messages, model = "openai") {
    try {
      const response = await fetch(this.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          model,
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        throw new Error(`API call failed: ${response.statusText}`);
      }

      // Add error handling for text response
      const text = await response.text();
      
      try {
        // Try to parse as JSON first
        const data = JSON.parse(text);
        return data.choices?.[0]?.message?.content?.trim() || text;
      } catch (e) {
        // If not JSON, return the raw text
        return text.trim();
      }

    } catch (error) {
      logger.error("Error calling Pollinations API", { 
        error: error.message,
        endpoint: this.apiEndpoint 
      });
      throw error;
    }
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
    const emailData = emails.map(email => ({
      subject: email.subject || 'No Subject',
      from: email.from || 'Unknown Sender',
      date: email.date || new Date().toISOString(),
      priority: this.calculatePriority(email)
    }));

    const systemMessage = `Summarize these emails concisely and highlight important items.
Format the summary with these sections:
🚨 URGENT/IMPORTANT:
📥 KEY UPDATES:
⚡️ ACTIONS NEEDED:
📊 INSIGHTS:`;

    const formattedEmails = emailData
      .map(email => `From: ${email.from}\nSubject: ${email.subject}\nPriority: ${email.priority}`)
      .join('\n\n');

    const messages = [
      { role: "system", content: systemMessage },
      { role: "user", content: formattedEmails }
    ];

    return this.callPollinationsAPI(messages);
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
