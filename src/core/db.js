// ─── 数据库操作与状态管理 ───────────────────────────────────────────────────
/**
 * 格式化规则对象
 */
function mapRule(row) {
  return {
    id: Number(row.id),
    remark: row.remark ? String(row.remark) : "",
    sender_filter: row.sender_filter ? String(row.sender_filter) : "",
    pattern: String(row.pattern),
    created_at: row.created_at ? Number(row.created_at) : Date.now()
  };
}

/**
 * 格式化白名单对象
 */
function mapWhitelist(row) {
  return {
    id: Number(row.id),
    sender_pattern: String(row.sender_pattern),
    created_at: row.created_at ? Number(row.created_at) : Date.now()
  };
}

/**
 * 获取所有解析规则 (供逻辑层使用)
 */
export async function loadRules(db) {
  const result = await db.prepare("SELECT id, remark, sender_filter, pattern FROM rules ORDER BY created_at DESC").all();
  return result.results.map(mapRule);
}

/**
 * 获取所有发件人白名单 (供逻辑层使用)
 */
export async function loadWhitelist(db) {
  const result = await db.prepare("SELECT id, sender_pattern FROM whitelist ORDER BY created_at DESC").all();
  return result.results.map(mapWhitelist);
}

/**
 * 获取针对特定收件地址的最新邮件记录
 */
export async function getLatestEmail(db, address) {
  const addr = String(address || "").trim().toLowerCase();
  return db.prepare(
    "SELECT from_address, to_address, extracted_json, received_at FROM emails WHERE instr(',' || to_address || ',', ',' || ? || ',') > 0 ORDER BY received_at DESC LIMIT 1"
  ).bind(addr).first();
}

/**
 * 分页获取邮件记录 (支持域名过滤)
 */
export async function getEmails(db, page, pageSize, domain = null, toAddress = null) {
  const offset = (page - 1) * pageSize;
  let query = "SELECT message_id, from_address, to_address, subject, extracted_json, received_at FROM emails";
  let countQuery = "SELECT COUNT(1) as total FROM emails";
  const params = [pageSize, offset];
  const countParams = [];
  const conditions = [];
  const countConditions = [];

  if (domain) {
    const domainPattern = `%@${domain}%`;
    conditions.push("to_address LIKE ?");
    countConditions.push("to_address LIKE ?");
    params.unshift(domainPattern);
    countParams.push(domainPattern);
  }

  if (toAddress) {
    const addressPattern = `%${toAddress}%`;
    conditions.push("to_address LIKE ?");
    countConditions.push("to_address LIKE ?");
    params.unshift(addressPattern);
    countParams.push(addressPattern);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
    countQuery += " WHERE " + countConditions.join(" AND ");
  }

  query += " ORDER BY received_at DESC LIMIT ? OFFSET ?";

  const [list, countRow] = await Promise.all([
    db.prepare(query).bind(...params).all(),
    db.prepare(countQuery).bind(...countParams).first()
  ]);
  return { items: list.results, total: countRow?.total || 0 };
}

/**
 * 按 message_id 获取邮件详情（含原文字段）
 */
export async function getEmailDetailByMessageId(db, messageId) {
  try {
    return await db.prepare(
      "SELECT message_id, from_address, to_address, subject, received_at, raw_text, raw_html FROM emails WHERE message_id = ? LIMIT 1"
    ).bind(messageId).first();
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (!/raw_text|raw_html|has no column named/i.test(msg)) throw err;

    const row = await db.prepare(
      "SELECT message_id, from_address, to_address, subject, received_at FROM emails WHERE message_id = ? LIMIT 1"
    ).bind(messageId).first();
    if (!row) return null;
    return { ...row, raw_text: null, raw_html: null };
  }
}

/**
 * 获取系统中出现过的所有唯一域名
 */
export async function getAvailableDomains(db) {
  const result = await db.prepare("SELECT to_address FROM emails").all();
  const domains = new Set();
  for (const row of result.results) {
    const addresses = row.to_address.split(",");
    for (const addr of addresses) {
      const parts = addr.trim().split("@");
      if (parts.length === 2) domains.add(parts[1]);
    }
  }
  return Array.from(domains).sort();
}

/**
 * 分页获取规则列表
 */
export async function getRulesPaged(db, page, pageSize) {
  const offset = (page - 1) * pageSize;
  const [list, countRow] = await Promise.all([
    db.prepare(
      "SELECT id, remark, sender_filter, pattern, created_at FROM rules ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(pageSize, offset).all(),
    db.prepare("SELECT COUNT(1) as total FROM rules").first()
  ]);
  return { items: list.results.map(mapRule), total: countRow?.total || 0 };
}

/**
 * 创建新规则
 */
export async function createRule(db, { remark, sender_filter, pattern }) {
  return db.prepare("INSERT INTO rules (remark, sender_filter, pattern, created_at) VALUES (?, ?, ?, ?)")
    .bind(remark || null, sender_filter || null, pattern, Date.now())
    .run();
}

/**
 * 删除规则
 */
export async function deleteRule(db, id) {
  return db.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
}

/**
 * 分页获取白名单
 */
export async function getWhitelistPaged(db, page, pageSize) {
  const offset = (page - 1) * pageSize;
  const [list, countRow] = await Promise.all([
    db.prepare(
      "SELECT id, sender_pattern, created_at FROM whitelist ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).bind(pageSize, offset).all(),
    db.prepare("SELECT COUNT(1) as total FROM whitelist").first()
  ]);
  return { items: list.results.map(mapWhitelist), total: countRow?.total || 0 };
}

/**
 * 创建白名单项
 */
export async function createWhitelistEntry(db, pattern) {
  return db.prepare("INSERT INTO whitelist (sender_pattern, created_at) VALUES (?, ?)")
    .bind(pattern, Date.now())
    .run();
}

/**
 * 删除白名单项
 */
export async function deleteWhitelistEntry(db, id) {
  return db.prepare("DELETE FROM whitelist WHERE id = ?").bind(id).run();
}
/**
 * 存储处理过的邮件记录
 */
export async function saveEmail(db, data) {
  const { from, to, subject, matches, text, html } = data;
  const baseParams = [
    crypto.randomUUID(),
    from,
    to.join(","),
    subject,
    JSON.stringify(matches),
    Date.now()
  ];

  try {
    return await db.prepare(
      "INSERT INTO emails (message_id, from_address, to_address, subject, extracted_json, received_at, raw_text, raw_html) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      ...baseParams,
      text || null,
      html || null
    ).run();
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (!/raw_text|raw_html|has no column named/i.test(msg)) throw err;

    // 兼容尚未执行 0002 迁移的旧库结构
    return db.prepare(
      "INSERT INTO emails (message_id, from_address, to_address, subject, extracted_json, received_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(...baseParams).run();
  }
}

/**
 * 清理指定小时数之前的过期邮件
 */
export async function clearExpiredEmails(db, maxHours = 48) {
  const threshold = Date.now() - (maxHours * 60 * 60 * 1000);
  return db.prepare("DELETE FROM emails WHERE received_at < ?").bind(threshold).run();
}
