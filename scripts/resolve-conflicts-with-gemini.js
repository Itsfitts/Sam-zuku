/**
 * @fileoverview This script automates the resolution of Git merge conflicts
 * using the Google Gemini API. It is designed to be run in a GitHub Actions
 * environment when a `git merge` or `git rebase` command fails.
 *
 * It performs the following steps:
 * 1. Identifies all files with merge conflicts.
 * 2. Checks if the conflicted path is a directory (submodule). If so, it skips it.
 * 3. For each file, it reads the content and extracts the conflicting blocks.
 * 4. It constructs a prompt for the Gemini API, providing the conflicting code sections.
 * 5. It calls the Gemini API to get a suggested resolution.
 * 6. It replaces the conflict block in the file with the AI's suggestion.
 * 7. The process is repeated for all conflicts in all files.
 *
 * This script requires the GEMINI_API_KEY and GEMINI_MODEL_NAME environment variables to be set.
 */

const { execSync } = require('child_process');
const fs = require('fs').promises;
const https = require('https');
const path = require('path');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash-preview-05-20';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent`;
const MAX_RETRIES = 3;

/**
 * Executes a shell command and returns its stdout.
 * @param {string} command The command to execute.
 * @returns {string} The stdout of the command.
 */
function runCommand(command) {
    try {
        return execSync(command).toString().trim();
    } catch (error) {
        console.error(`Error executing command: ${command}`);
        console.error(error.stderr.toString());
        throw error;
    }
}

/**
 * Makes a POST request to the Gemini API with retry logic.
 * @param {object} payload The JSON payload to send.
 * @returns {Promise<object>} The JSON response from the API.
 */
async function callGeminiAPI(payload) {
    const url = new URL(GEMINI_API_URL);
    url.searchParams.append('key', GEMINI_API_KEY);

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    };

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const req = https.request(url, options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(data));
                        } else {
                            reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
                        }
                    });
                });
                req.on('error', reject);
                req.write(JSON.stringify(payload));
                req.end();
            });
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed. Retrying in ${2 ** i}s...`);
            if (i === MAX_RETRIES - 1) throw error;
            await new Promise(res => setTimeout(res, 1000 * (2 ** i)));
        }
    }
}

/**
 * Gets a conflict resolution suggestion from the Gemini API.
 * @param {string} ourCode The code from the current branch (HEAD).
 * @param {string} theirCode The code from the incoming branch.
 * @param {string} filePath The path to the conflicted file for context.
 * @returns {Promise<string>} The resolved code suggested by the AI.
 */
async function getGeminiResolution(ourCode, theirCode, filePath) {
    console.log(`Asking Gemini for resolution in: ${filePath}`);

    const prompt = `
You are an expert software developer specializing in resolving Git conflicts.
Analyze the two conflicting code blocks below from the file "${filePath}" and provide a clean, resolved version that logically merges the changes.

- IMPORTANT: Do NOT include the git conflict markers (<<<<<<<, =======, >>>>>>>) in your response.
- Only output the final, resolved code block. Do not add explanations, apologies, or any other text. Just the code.

--- INCOMING CHANGE ---
${theirCode}
---

--- CURRENT CHANGE ---
${ourCode}
---

--- RESOLVED CODE ---
`;

    const payload = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            temperature: 0.2, // Lower temperature for more deterministic, code-like output
            maxOutputTokens: 2048,
        }
    };

    const response = await callGeminiAPI(payload);
    try {
        return response.candidates[0].content.parts[0].text.trim();
    } catch (error) {
        console.error("Error parsing Gemini response:", JSON.stringify(response, null, 2));
        throw new Error("Could not extract resolved code from Gemini's response.");
    }
}

/**
 * Reads a file, resolves all conflicts using Gemini, and writes it back.
 * @param {string} filePath The path to the conflicted file.
 */
async function resolveConflictsInFile(filePath) {
    console.log(`Resolving conflicts in ${filePath}...`);
    let content = await fs.readFile(filePath, 'utf-8');

    const conflictRegex = /<<<<<<<[^\n]*\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>[^\n]*/g;
    const matches = [...content.matchAll(conflictRegex)];

    if (matches.length === 0) {
        console.log(`No conflict markers found in ${filePath}. Skipping.`);
        return;
    }

    // Process conflicts sequentially from bottom to top to avoid index shifting
    for (const match of matches.reverse()) {
        const fullConflictBlock = match[0];
        const ourCode = match[1];
        const theirCode = match[2];

        const resolvedCode = await getGeminiResolution(ourCode, theirCode, filePath);
        console.log(`Successfully received resolution for a conflict in ${filePath}.`);

        // Replace the specific conflict block
        content = content.substring(0, match.index) + resolvedCode + content.substring(match.index + fullConflictBlock.length);
    }

    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`Successfully wrote resolved content to ${filePath}.`);
}


/**
 * Main function to orchestrate the conflict resolution process.
 */
async function main() {
    if (!GEMINI_API_KEY) {
        console.error("GEMINI_API_KEY environment variable is not set. Aborting.");
        process.exit(1);
    }

    console.log(`Starting AI-powered conflict resolution process using model: ${GEMINI_MODEL_NAME}`);
    const conflictedFiles = runCommand("git diff --name-only --diff-filter=U").split('\n').filter(Boolean);

    if (conflictedFiles.length === 0) {
        console.log("No conflicted files found. Nothing to do.");
        return;
    }

    console.log(`Found ${conflictedFiles.length} conflicted path(s):`);
    conflictedFiles.forEach(file => console.log(`- ${file}`));

    let unresolvedSubmodules = false;

    try {
        for (const file of conflictedFiles) {
            const stats = await fs.stat(file);
            if (stats.isDirectory()) {
                console.warn(`::warning::Conflict detected in submodule '${file}'. This script cannot resolve submodule conflicts. Please resolve it manually.`);
                unresolvedSubmodules = true;
                continue; // Skip to the next file
            }
            await resolveConflictsInFile(file);
            // Stage the resolved file
            runCommand(`git add ${file}`);
        }

        if (unresolvedSubmodules) {
             console.error("::error::There are unresolved submodule conflicts that require manual intervention.");
             process.exit(1); // Exit with an error to halt the workflow
        }

        console.log("All file conflicts resolved and staged successfully.");
    } catch (error) {
        console.error("An error occurred during conflict resolution:", error);
        process.exit(1);
    }
}

main();

