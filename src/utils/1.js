/**
 * Language-agnostic email thread cleaner that focuses on structural patterns
 * @param {Object[]} messages - Array of email messages with id, body, from, internalDate
 * @returns {Object[]} Cleaned messages
 */
function cleanEmailThread(messages) {
    const sortedMessages = [...messages].sort((a, b) => 
      parseInt(a.internalDate) - parseInt(b.internalDate)
    );
  
    // // Universal email structural patterns
    // const patterns = {
    //   // Match quoted text blocks based on structural markers
    //   quotes: [
    //     // Match "On [date], at [time]" format
    //     /(?:^|\s|\.)On\s+\d{1,2}\.\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4},?\s+(?:at\s+)?\d{1,2}[:\.]\d{2}.*[\s\S]*?(?:wrote|sent|says).*?[:\n]/gim,
        
    //     // Email client quote headers (date/time based)
    //     /(?:(?:[0-9]{1,2}[:.])?[0-9]{1,2}[:.]?[0-9]{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec).{0,10}[0-9]{1,2}.{0,10}[0-9]{2,4})[^\n]{0,50}[:\n]/gi,
        
    //     // Quote markers
    //     /^>+.*/gm,                    // Basic quote marker
    //     /^│.*/gm,                     // Vertical line quotes
    //     /^[|┃║].*/gm,                 // Various vertical separators
        
    //     // Common email client quote patterns
    //     /["'][\s\S]{1,50}["'] (?:\S+@\S+|\S+) [\s\S]{1,30}[:]\s*/g,  // Name/email followed by colon
    //     /\S+@\S+.*?(?:wrote|sent|says).*?[:\n]/gi,   // Email address with action word
    //   ],
  
    //   // Match common contact/signature blocks
    //   signatures: [
    //     // Signature dividers - remove everything from -- onwards
    //     /^--.*[\s\S]*$/m,
        
    //     // Common signature elements (match by structure, not specific words)
    //     /(?:\+|00)[0-9()\-\s]{8,}/g,      // Phone numbers
    //     /[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/g,  // Email addresses
        
    //     // Common signature block patterns
    //     /^[\s\S]{0,100}@[\s\S]{0,100}\n.{0,100}\n.{0,100}$/m,  // 2-3 lines with @ symbol
    //   ],

    //   // HTML and CSS patterns
    //   html: [
    //     // Remove entire style blocks and their content
    //     /<style[^>]*>[\s\S]*?<\/style>/gi,
        
    //     // Common HTML email elements and their content, but only when they contain CSS-like content
    //     /<(?:style|script)[^>]*>[\s\S]*?<\/(?:style|script)>/gi,
    //     /class=["'][^"']*["']/g,
    //     /style=["'][^"']*["']/g,
        
    //     // Remove HTML comments
    //     /<!--[\s\S]*?-->/g,
        
    //     // Remove CSS-like declarations while preserving content
    //     /\{[^}]*\}/g,  // CSS rule blocks
    //     /^\s*[.#][a-zA-Z-]+\s*$/gm,  // CSS selectors on their own lines
    //     /^[a-z-]+:\s*[^;\n]+;\s*$/gim,  // CSS property declarations on their own lines
        
    //     // Special characters
    //     /͏/g,   // Zero-width characters
    //     /­/g,   // Soft hyphens
    //   ]
    // };
  
    // // Storage for previously seen content
    // const seenContent = new Map();  // Using Map to store normalized versions
  
    // function normalizeText(text) {
    //   return text
    //     .toLowerCase()
    //     .replace(/\s+/g, ' ')
    //     .trim();
    // }
  
    // function removePatternsFromText(text, patternArray) {
    //   let cleaned = text;
    //   for (const pattern of patternArray) {
    //     cleaned = cleaned.replace(pattern, '');
    //   }
    //   return cleaned;
    // }
  
    return sortedMessages.map(message => {
      let cleanedBody = message.body;
      
      // console.log("\n=== BEFORE CLEANUP ===\n", message.body);1
      
      // remove any text including this pattern and following it: On Sun, Jan 19, 2025 starting at a new line
      // any of those dates
      const replyPatterns = [
        // Standard format: "On Sun, Jan 19, 2025" after newline, period, or question mark
        /(?:\n|[.?])[Oo]n\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}.*$/s,
        // European format: "On 19. Jan 2025" after newline, period, or question mark
        /(?:\n|[.?])[Oo]n\s+\d{1,2}\.\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}.*$/s
      ];

      cleanedBody = message.body;
      for (const pattern of replyPatterns) {
        cleanedBody = cleanedBody.replace(pattern, '');
      }

      // // Remove HTML/CSS first
      // cleanedBody = removePatternsFromText(cleanedBody, patterns.html);
      
      // // Remove quote patterns
      // cleanedBody = removePatternsFromText(cleanedBody, patterns.quotes);
      
      // // Remove signatures
      // cleanedBody = removePatternsFromText(cleanedBody, patterns.signatures);
  
      // Remove any previously seen content using fuzzy matching
      // const normalizedCurrent = normalizeText(cleanedBody);
      // for (const [original, normalized] of seenContent) {
      //   if (normalizedCurrent.includes(normalized)) {
      //     cleanedBody = cleanedBody.replace(original, '');
      //   }
      // }
  
      // // Clean up only excessive whitespace while preserving formatting
      // cleanedBody = cleanedBody
      //   .split('\n')
      //   .map(line => line.replace(/\s+$/, ''))  // Only trim trailing spaces
      //   .join('\n')
      //   .replace(/\n{4,}/g, '\n\n\n');  // Reduce more than 3 newlines to 3
  
      // console.log("\n=== AFTER CLEANUP ===\n", cleanedBody);
      // console.log("\n=== END OF MESSAGE ===\n");
  
      // Store normalized version for future comparison
      // Only store if significant content remains
      // if (cleanedBody.length > 20) {
      //   seenContent.set(message.body, normalizeText(cleanedBody));
      // }
      return {
        id: message.id,
        from: message.from,
        threadId: message.threadId,
        internalDate: message.internalDate,
        subject: message.subject,
        body: cleanedBody,
        cleaned: cleanedBody !== message.body,
        senderIsMe: message.senderIsMe,
        to: message.to,
        date: message.date
      };
    });
  }
  
module.exports = cleanEmailThread;
//   // Example usage with one of your threads:
//   const thread = {
//     threadId: '19480a4ccc6597a9',
//     messages: [
//       {
//         id: '19480a4ccc6597a9',
//         from: 'Hybrid Space Lab <hybridspacelab@gmail.com>',
//         body: 'Crisis?',
//         internalDate: '1737325068000'
//       },
//       {
//         id: '19480bf3ab32f75c',
//         from: 'Thomash Haferlach <thomash@pollinations.ai>',
//         body: 'crisis.mp4 On Sun, Jan 19, 2025 at 11:17 PM Hybrid Space Lab wrote: Crisis?',
//         internalDate: '1737326803000'
//       },
//       {
//         id: '19480cc30fe9d3f2',
//         from: 'Hybrid Space Lab <hybridspacelab@gmail.com>',
//         body: "Maybe this is a way to show/adress in the workshop crisis in general, I have an extensive image library of disasters. I'm now wondering: is it possible to use data from on public at cultural institutes and let that drive an animation?",
//         internalDate: '1737327640000'
//       }
//     ]
//   };
  
//   const cleaned = cleanEmailThread(thread.messages);
//   console.log('\nCleaned thread:');
//   cleaned.forEach((msg, i) => {
//     console.log(`\nMessage ${i + 1} from ${msg.from}:`);
//     console.log(msg.body);
//   });