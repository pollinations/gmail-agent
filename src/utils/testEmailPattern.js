const testEmail = `Crisis?
---
crisis.mp4 

On Sun, Jan 19, 2025 at 11:17 PM Hybrid Space Lab 
wrote: 

*Thomas Haferlach* 
*Pollinations.AI * 
*thomash@pollinations.ai* 
+49 (0) 1754863246 
*Koepenicker Chaussee 26* 
*10317 Berlin | **Germany*
---
Maybe this is a way to show/adress in the workshop crisis in general, I have an extensive image library of disasters.I'm now wondering: is it possible to use data from on public at cultural institutes and let that drive an animation?On 19. Jan 2025, at 23:47, Thomash Haferlach wrote: crisis.mp4On Sun, Jan 19, 2025 at 11:17 PM Hybrid Space Lab wrote:Crisis?`;

const replyPatterns = [
    // Standard format: "On Sun, Jan 19, 2025"
    /\n[Oo]n\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}.*$/s,
    // European format: "On 19. Jan 2025"
    /\n[Oo]n\s+\d{1,2}\.\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}.*$/s
];

let cleanedBody = testEmail;
console.log("=== ORIGINAL TEXT ===");
console.log(testEmail);

for (const pattern of replyPatterns) {
    cleanedBody = cleanedBody.replace(pattern, '');
}

console.log("\n=== CLEANED TEXT ===");
console.log(cleanedBody);
