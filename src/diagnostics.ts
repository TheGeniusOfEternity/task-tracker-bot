// Log only known error categories, never messages, URLs, queries, payloads or credentials.
export function failureDetails(error: unknown): { kind: string; code?: string; timeout: boolean } {
  const kinds = new Set(['Error','TypeError','BotError','GrammyError','HttpError','DatabaseError']);
  const codes = new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE']);
  const details: { kind: string; code?: string; timeout: boolean } = { kind: 'Error',timeout: false };
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const record = current as Record<string,unknown>;
    if (typeof record.name === 'string' && kinds.has(record.name)) details.kind = record.name;
    if (typeof record.code === 'string' && (codes.has(record.code) || /^[0-9A-Z]{5}$/.test(record.code))) details.code = record.code;
    if (typeof record.message === 'string' && /timeout|timed out/i.test(record.message)) details.timeout = true;
    current = record.cause ?? record.error;
  }
  return details;
}
