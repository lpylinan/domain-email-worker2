import PostalMime from "postal-mime";
import { loadRules, loadWhitelist, saveEmail } from "./db.js";
import { MAX_MATCH_CONTENT_CHARS, MAX_RULE_PATTERN_LENGTH, MAX_SENDER_PATTERN_LENGTH } from "../utils/constants.js";

// ─── 核心业务逻辑 (Email Processing) ──────────────────────────────────────────

/**
 * 解析入站邮件的原始数据
 */
async function parseIncomingEmail(message) {
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const parsed = await new PostalMime().parse(rawBuffer);
  const toList = Array.isArray(parsed.to) ? parsed.to : [];

  return {
    from: parsed.from?.address || "",
    to: toList.map((item) => item.address).filter(Boolean),
    subject: parsed.subject || "",
    text: parsed.text || "",
    html: parsed.html || ""
  };
}

/**
 * 从 HTML 中提取纯文本（剥离标签、解码实体）
 */
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")   // 移除 <style> 块
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")  // 移除 <script> 块
    .replace(/<br\s*\/?>/gi, "\n")                     // <br> → 换行
    .replace(/<\/p>/gi, "\n")                          // </p> → 换行
    .replace(/<\/tr>/gi, "\n")                         // </tr> → 换行
    .replace(/<\/div>/gi, "\n")                        // </div> → 换行
    .replace(/<[^>]+>/g, "")                           // 移除所有剩余标签
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\n{3,}/g, "\n\n")                       // 合并多余空行
    .trim();
}

/**
 * 对邮件内容应用解析规则
 */
function applyRules(content, sender, rules) {
  const senderValue = String(sender || "").toLowerCase();
  const safeContent = String(content || "").slice(0, MAX_MATCH_CONTENT_CHARS);
  const outputs = [];
  for (const rule of rules) {
    if (!senderMatches(senderValue, rule.sender_filter)) continue;
    try {
      const pattern = String(rule.pattern || "");
      if (!pattern || pattern.length > MAX_RULE_PATTERN_LENGTH) continue;
      const match = safeContent.match(new RegExp(pattern, "m"));
      if (match?.[0]) {
        outputs.push({ rule_id: rule.id, value: match[0], remark: rule.remark || null });
      }
    } catch { continue; }
  }
  return outputs;
}

/**
 * 检查发件人是否在白名单中
 */
function senderInWhitelist(sender, whitelist) {
  if (whitelist.length === 0) return true;
  const senderValue = String(sender || "").toLowerCase();
  return whitelist.some(({ sender_pattern }) => {
    const pattern = String(sender_pattern || "");
    if (!pattern || pattern.length > MAX_SENDER_PATTERN_LENGTH) return false;
    try { return new RegExp(pattern, "i").test(senderValue); } catch { return false; }
  });
}

/**
 * 辅助函数：匹配发件人与过滤规则
 */
function senderMatches(senderValue, filterValue) {
  const filter = String(filterValue || "").trim();
  if (!filter) return true;
  const parts = filter.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 || parts.some((pattern) => {
    if (!pattern || pattern.length > MAX_SENDER_PATTERN_LENGTH) return false;
    try { return new RegExp(pattern, "i").test(senderValue); } catch { return false; }
  });
}

/**
 * 集中处理入站邮件的完整流程 (解析 -> 过滤 -> 匹配 -> 存储)
 */
export async function processIncomingEmail(message, env, ctx) {
  const parsed = await parseIncomingEmail(message);

  // Normalize emails to reduce case-sensitivity surprises
  parsed.from = String(parsed.from || "").toLowerCase();
  parsed.to = Array.isArray(parsed.to) ? parsed.to.map((a) => String(a || "").toLowerCase()) : [];

  // 1. 白名单检查
  const whitelist = await loadWhitelist(env.DB);
  if (!senderInWhitelist(parsed.from, whitelist)) return null;

  // 2. 匹配规则提取内容（优先纯文本，HTML 需先剥离标签）
  const rules = await loadRules(env.DB);
  const content = parsed.text || (parsed.html ? stripHtml(parsed.html) : "");
  const matches = applyRules(content, parsed.from, rules);

  // 3. 异步持久化存储
  ctx.waitUntil(saveEmail(env.DB, { ...parsed, matches }));

  return parsed;
}
