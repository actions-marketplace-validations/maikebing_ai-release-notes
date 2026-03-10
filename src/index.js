"use strict";

const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
 * @param {string} fromTag
 * @param {string} toTag
 */
async function ensureTags(fromTag, toTag) {
  core.info("Fetching all tags...");
  await exec.exec("git", ["fetch", "--force", "--tags"]);

  const fromCheck = await getExecOutput("git", ["rev-parse", "--verify", fromTag]);
  if (fromCheck.exitCode !== 0) {
    throw new Error(
      `from_tag not found: "${fromTag}". Make sure the tag exists and the repository was checked out with fetch-depth: 0.`
    );
  }

  const toCheck = await getExecOutput("git", ["rev-parse", "--verify", toTag]);
  if (toCheck.exitCode !== 0) {
    throw new Error(
      `to_tag not found: "${toTag}". Make sure the tag exists and the repository was checked out with fetch-depth: 0.`
    );
  }

  core.info(`from_tag: ${fromTag} (${fromCheck.stdout.trim()})`);
  core.info(`to_tag:   ${toTag} (${toCheck.stdout.trim()})`);
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
 * Generate release notes by calling the Ollama model.
 * @param {string} model
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function generateNotes(model, prompt) {
  core.info(`Generating release notes with model: ${model} ...`);

  const tmpFile = path.join(os.tmpdir(), "ollama-prompt.txt");
  fs.writeFileSync(tmpFile, prompt, "utf8");

  const result = await getExecOutput("bash", [
    "-c",
    `ollama run "${model}" < "${tmpFile}"`,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`ollama run failed (exit ${result.exitCode}): ${result.stderr}`);
  }

  const notes = result.stdout.trim();
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
    const fromTag = core.getInput("from_tag", { required: true });
    const toTag = core.getInput("to_tag", { required: true });
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
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(model)) {
      throw new Error(`Invalid model name "${model}". Only alphanumeric characters, colons, dots, dashes, slashes and @ are allowed.`);
    }

    // Validate ollama host is a safe URL (no shell special characters)
    if (!/^https?:\/\/[a-zA-Z0-9._:[\]-]+$/.test(ollamaHost)) {
      throw new Error(`Invalid ollama_host "${ollamaHost}". Must be a plain HTTP/HTTPS URL without path or query.`);
    }

    core.info(`from_tag:         ${fromTag}`);
    core.info(`to_tag:           ${toTag}`);
    core.info(`model:            ${model}`);
    core.info(`language:         ${language}`);
    core.info(`include_diffstat: ${includeDiffstat}`);

    // --- Validate tags ---
    await ensureTags(fromTag, toTag);

    // --- Collect commits ---
    const commits = await buildCommitLog(fromTag, toTag);
    core.info("Commit log collected.");
    core.debug(commits);

    // --- Optionally collect diffstat ---
    let diffstat = "";
    if (includeDiffstat) {
      diffstat = await buildDiffStat(fromTag, toTag);
    }

    // --- Install & start Ollama ---
    await installOllama();
    await startOllama(ollamaHost);

    // --- Pull model ---
    await pullModel(model);

    // --- Build prompt ---
    const prompt = buildPrompt(fromTag, toTag, commits, diffstat, language);
    core.debug("Prompt:\n" + prompt);

    // --- Generate notes ---
    const notes = await generateNotes(model, prompt);

    // --- Outputs ---
    core.setOutput("release_notes", notes);
    core.setOutput("commits", commits);

    // --- Write to step summary ---
    await core.summary
      .addHeading("📋 AI Release Notes Summary")
      .addTable([
        [
          { data: "Item", header: true },
          { data: "Value", header: true },
        ],
        ["From tag", `\`${fromTag}\``],
        ["To tag", `\`${toTag}\``],
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
