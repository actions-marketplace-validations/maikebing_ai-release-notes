"use strict";

const core = require("@actions/core");
const exec = require("@actions/exec");
const http = require("http");
const https = require("https");
const { URL } = require("url");

/**
 * Run a command and capture its stdout/stderr.
 * @param {string} command
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function getExecOutput(command, args = [], options = {}) {
  let stdout = "";
  let stderr = "";

  const execOptions = {
    ...options,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
      stderr: (data) => {
        stderr += data.toString();
      },
    },
  };

  const exitCode = await exec.exec(command, args, execOptions);
  return { exitCode, stdout, stderr };
}

/**
 * Ensure both tags exist in the local repository.
 * @param {string} fromRef
 * @param {string} toRef
 */
async function ensureRefs(fromRef, toRef) {
  const fromCheck = await getExecOutput("git", ["rev-parse", "--verify", fromRef]);
  if (fromCheck.exitCode !== 0) {
    throw new Error(
      `from_tag not found: "${fromRef}". Make sure the tag exists and the repository was checked out with fetch-depth: 0.`
    );
  }

  const toCheck = await getExecOutput("git", ["rev-parse", "--verify", toRef]);
  if (toCheck.exitCode !== 0) {
    throw new Error(
      `to_tag not found: "${toRef}". Make sure the tag exists and the repository was checked out with fetch-depth: 0.`
    );
  }

  core.info(`from: ${fromRef} (${fromCheck.stdout.trim()})`);
  core.info(`to:   ${toRef} (${toCheck.stdout.trim()})`);
}

/**
 * Auto-detect the current ("to") ref and the previous ("from") ref.
 *
 * Rules:
 *  - If GITHUB_REF is a tag (refs/tags/...) → to = that tag name.
 *  - Otherwise → to = "HEAD".
 *  - Previous tag is resolved via `git describe --tags --abbrev=0 <to>^`
 *    (i.e. the nearest tag that is an ancestor of <to> but not <to> itself).
 *  - If no previous tag exists, fall back to the initial commit SHA.
 *
 * @returns {Promise<{fromRef: string, toRef: string}>}
 */
async function autoDetectRefs() {
  const githubRef = process.env.GITHUB_REF || "";
  const githubRefName = process.env.GITHUB_REF_NAME || "";

  // ---- Determine toRef ----
  let toRef;
  let toParent; // the ref to search for the previous tag from

  if (githubRef.startsWith("refs/tags/")) {
    toRef = githubRefName;
    // Search for previous tag starting from the commit just before this tag
    toParent = `${toRef}^`;
    core.info(`Auto-detected: running on tag "${toRef}".`);
  } else {
    toRef = "HEAD";
    toParent = "HEAD";
    const branchInfo = githubRefName ? ` (branch: ${githubRefName})` : "";
    core.info(`Auto-detected: not running on a tag${branchInfo}. Using HEAD as to_ref.`);
  }

  // ---- Determine fromRef (previous tag) ----
  const descResult = await getExecOutput("git", [
    "describe",
    "--tags",
    "--abbrev=0",
    toParent,
  ]);

  let fromRef;
  if (descResult.exitCode === 0 && descResult.stdout.trim()) {
    fromRef = descResult.stdout.trim();
    core.info(`Auto-detected previous tag: "${fromRef}".`);
  } else {
    // No previous tag — fall back to the initial commit
    const initResult = await getExecOutput("git", [
      "rev-list",
      "--max-parents=0",
      "HEAD",
    ]);
    fromRef = initResult.stdout.trim();
    core.warning(
      `No previous tag found. Using initial commit ${fromRef} as from_ref.`
    );
  }

  return { fromRef, toRef };
}

/**
 * Collect the commit log between two tags.
 * @param {string} fromTag
 * @param {string} toTag
 * @returns {Promise<string>}
 */
async function buildCommitLog(fromTag, toTag) {
  const result = await getExecOutput("git", [
    "log",
    `${fromTag}..${toTag}`,
    "--no-merges",
    "--pretty=format:- %s (%an, %h)",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to get git log: ${result.stderr}`);
  }

  return result.stdout.trim() || "- (no commits found)";
}

/**
 * Collect the diff stat between two tags.
 * @param {string} fromTag
 * @param {string} toTag
 * @returns {Promise<string>}
 */
async function buildDiffStat(fromTag, toTag) {
  const result = await getExecOutput("git", ["diff", "--stat", fromTag, toTag]);

  if (result.exitCode !== 0) {
    core.warning(`Failed to get diffstat: ${result.stderr}`);
    return "";
  }

  return result.stdout.trim();
}

/**
 * Install Ollama on the runner.
 */
async function installOllama() {
  core.info("Installing Ollama...");
  await exec.exec("bash", [
    "-c",
    "curl -fsSL https://ollama.com/install.sh | sh",
  ]);
}

/**
 * Start the Ollama server in the background and wait until it is ready.
 * @param {string} host  e.g. "http://127.0.0.1:11434"
 */
async function startOllama(host) {
  core.info("Starting Ollama server...");
  await exec.exec("bash", [
    "-c",
    "nohup ollama serve > ollama.log 2>&1 &",
  ]);

  // Wait until the server is accepting connections (up to 30 seconds).
  const url = `${host}/api/version`;
  const maxRetries = 30;
  for (let i = 0; i < maxRetries; i++) {
    const result = await getExecOutput("bash", [
      "-c",
      `curl -sf "${url}" > /dev/null 2>&1 && echo ok`,
    ]);
    if (result.stdout.trim() === "ok") {
      core.info("Ollama server is ready.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Ollama server did not start within 30 seconds.");
}

/**
 * Pull a model from the Ollama registry.
 * @param {string} model
 */
async function pullModel(model) {
  core.info(`Pulling model: ${model} ...`);
  await exec.exec("ollama", ["pull", model]);
}

/**
 * Build the prompt text based on the selected language.
 * @param {string} fromTag
 * @param {string} toTag
 * @param {string} commits
 * @param {string} diffstat
 * @param {string} language  "zh" | "en" | "both"
 * @returns {string}
 */
function buildPrompt(fromTag, toTag, commits, diffstat, language) {
  const diffSection =
    diffstat
      ? `\nFile change statistics:\n${diffstat}\n`
      : "";

  if (language === "en") {
    return `You are an experienced release manager.
Based on the git commits listed below between two tags, generate professional release notes in English.

Requirements:
1. Use Markdown format.
2. Include the following sections:
   - Overview
   - New Features
   - Bug Fixes
   - Refactoring & Improvements
   - Other Changes
   - Upgrade Notes (write "No breaking changes" if none)
3. Classify, merge and summarise the commits – do NOT copy them verbatim.
4. If a commit message is ambiguous, describe it conservatively without guessing.
5. Append a "Full Commit List" section at the end with the original commit items unchanged.

Tag range:
From: ${fromTag}
To:   ${toTag}
${diffSection}
Commits:
${commits}`.trim();
  }

  if (language === "both") {
    return `You are an experienced release manager.
Based on the git commits listed below between two tags, generate professional bilingual (Chinese and English) release notes.

Requirements:
1. Use Markdown format.
2. Output the full release notes TWICE: first in Chinese, then in English.
3. Each language version must include the following sections:
   - Overview / 概述
   - New Features / 新增功能
   - Bug Fixes / 问题修复
   - Refactoring & Improvements / 重构与优化
   - Other Changes / 其他变更
   - Upgrade Notes / 升级影响（如果没有就写"无明显破坏性变更" / "No breaking changes"）
4. Classify, merge and summarise the commits – do NOT copy them verbatim.
5. If a commit message is ambiguous, describe it conservatively without guessing.
6. Append a "Full Commit List / 完整提交列表" section at the very end with the original commit items unchanged.

Tag range / Tag 范围:
From / 从: ${fromTag}
To / 到:   ${toTag}
${diffSection}
Commits / 提交记录:
${commits}`.trim();
  }

  // Default: zh
  return `你是一名资深发布经理。请根据下面两个 Git tag 之间的提交记录，生成一份中文版本的变更说明（release notes）。

输出要求：
1. 使用 Markdown 格式
2. 包含以下小节：
   - 概述
   - 新增功能
   - 问题修复
   - 重构与优化
   - 其他变更
   - 升级影响（如果没有就写"无明显破坏性变更"）
3. 不要逐字重复所有 commit；请进行归类、合并、提炼
4. 如果某些 commit 信息不明确，请保守描述，不要臆造
5. 结尾追加一个"完整提交列表"小节，原样保留输入中的提交项

Tag 范围：
从：${fromTag}
到：${toTag}
${diffSection}
提交记录如下：
${commits}`.trim();
}

/**
 * Generate release notes by calling the Ollama HTTP API.
 * Using the REST API instead of `ollama run` CLI avoids ANSI terminal
 * escape codes (e.g. cursor-hide \x1b[25l / cursor-show \x1b[25h) that
 * the interactive CLI emits and that would otherwise pollute the output.
 * @param {string} model
 * @param {string} prompt
 * @param {string} host  e.g. "http://127.0.0.1:11434"
 * @returns {Promise<string>}
 */
async function generateNotes(model, prompt, host) {
  core.info(`Generating release notes with model: ${model} ...`);

  const url = new URL("/api/generate", host);
  const requestBody = JSON.stringify({ model, prompt, stream: false });

  const responseData = await new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody),
      },
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => { chunks.push(chunk); });
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.write(requestBody);
    req.end();
  });

  if (responseData.status !== 200) {
    throw new Error(`Ollama API request failed (HTTP ${responseData.status}): ${responseData.body}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseData.body);
  } catch (e) {
    throw new Error(`Failed to parse Ollama API response: ${e.message}`);
  }

  const notes = (parsed.response || "").trim();
  if (!notes) {
    throw new Error("Ollama returned an empty response. Try a different model or review the prompt.");
  }

  return notes;
}

/**
 * Main entry point.
 */
async function run() {
  try {
    // --- Inputs ---
    const fromTagInput = core.getInput("from_tag");
    const toTagInput = core.getInput("to_tag");
    const model = core.getInput("model") || "qwen2.5:0.5b";
    const language = (core.getInput("language") || "zh").toLowerCase();
    const includeDiffstat =
      (core.getInput("include_diffstat") || "false").toLowerCase() === "true";
    const ollamaHost =
      core.getInput("ollama_host") || "http://127.0.0.1:11434";

    if (!["zh", "en", "both"].includes(language)) {
      throw new Error(`Invalid language "${language}". Must be one of: zh, en, both.`);
    }

    // Validate model name to prevent shell injection (allow alphanumeric, colon, dot, dash, slash)
    // The optional @sha256:<hex> suffix covers digest-pinned model references.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:-]*(@sha256:[a-fA-F0-9]+)?$/.test(model)) {
      throw new Error(`Invalid model name "${model}". Only alphanumeric characters, colons, dots, dashes, and slashes are allowed (optionally followed by @sha256:<digest>).`);
    }

    // Validate ollama host is a safe URL (no shell special characters)
    if (!/^https?:\/\/[a-zA-Z0-9._:[\]-]+$/.test(ollamaHost)) {
      throw new Error(`Invalid ollama_host "${ollamaHost}". Must be a plain HTTP/HTTPS URL without path or query.`);
    }

    // --- Fetch all tags (needed for both manual input validation and auto-detection) ---
    core.info("Fetching all tags...");
    await exec.exec("git", ["fetch", "--force", "--tags"]);

    // --- Resolve from/to refs (auto-detect if not provided) ---
    let fromRef;
    let toRef;

    if (fromTagInput && toTagInput) {
      fromRef = fromTagInput;
      toRef = toTagInput;
      core.info(`Using provided tags: from=${fromRef}, to=${toRef}`);
    } else if (!fromTagInput && !toTagInput) {
      core.info("No tags provided — auto-detecting from git context...");
      ({ fromRef, toRef } = await autoDetectRefs());
    } else if (toTagInput && !fromTagInput) {
      toRef = toTagInput;
      core.info(`to_tag provided (${toRef}), auto-detecting previous tag...`);
      const toParent = `${toRef}^`;
      const descResult = await getExecOutput("git", [
        "describe", "--tags", "--abbrev=0", toParent,
      ]);
      if (descResult.exitCode === 0 && descResult.stdout.trim()) {
        fromRef = descResult.stdout.trim();
        core.info(`Auto-detected previous tag: "${fromRef}".`);
      } else {
        const initResult = await getExecOutput("git", [
          "rev-list", "--max-parents=0", "HEAD",
        ]);
        fromRef = initResult.stdout.trim();
        core.warning(`No previous tag found. Using initial commit ${fromRef} as from_ref.`);
      }
    } else {
      // from_tag provided but not to_tag
      fromRef = fromTagInput;
      toRef = "HEAD";
      core.info(`from_tag provided (${fromRef}), using HEAD as to_ref.`);
    }

    core.info(`from_ref:         ${fromRef}`);
    core.info(`to_ref:           ${toRef}`);
    core.info(`model:            ${model}`);
    core.info(`language:         ${language}`);
    core.info(`include_diffstat: ${includeDiffstat}`);

    // --- Validate refs exist ---
    await ensureRefs(fromRef, toRef);

    // --- Collect commits ---
    const commits = await buildCommitLog(fromRef, toRef);
    core.info("Commit log collected.");
    core.debug(commits);

    // --- Optionally collect diffstat ---
    let diffstat = "";
    if (includeDiffstat) {
      diffstat = await buildDiffStat(fromRef, toRef);
    }

    // --- Install & start Ollama ---
    await installOllama();
    await startOllama(ollamaHost);

    // --- Pull model ---
    await pullModel(model);

    // --- Build prompt ---
    const prompt = buildPrompt(fromRef, toRef, commits, diffstat, language);
    core.debug("Prompt:\n" + prompt);

    // --- Generate notes ---
    const notes = await generateNotes(model, prompt, ollamaHost);

    // --- Outputs ---
    core.setOutput("release_notes", notes);
    core.setOutput("commits", commits);
    core.setOutput("current_tag", toRef);
    core.setOutput("previous_tag", fromRef);

    // --- Write to step summary ---
    await core.summary
      .addHeading("📋 AI Release Notes Summary")
      .addTable([
        [
          { data: "Item", header: true },
          { data: "Value", header: true },
        ],
        ["From tag", `\`${fromRef}\``],
        ["To tag", `\`${toRef}\``],
        ["Model", `\`${model}\``],
        ["Language", language],
      ])
      .addHeading("Generated Release Notes", 2)
      .addRaw(notes, true)
      .write();

    core.info("Release notes generated successfully.");
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
