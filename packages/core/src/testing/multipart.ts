/**
 * A hand-built `multipart/form-data` body for `app.inject`, for the media send
 * route's tests: text fields first, then one file part.
 *
 * Moved from `apps/api/src/conversations.media.test.ts` (4A), unchanged, when
 * its cases split between the send-media slice and the whole-app suite.
 */

/** A fixed boundary, so a test can also build a body by hand around it. */
export const MULTIPART_BOUNDARY = "----VitestBoundary7";

/**
 * Builds the body and its content-type header.
 *
 * @param fields - Text fields, in order.
 * @param file - The one file part.
 * @returns `payload` and `headers` to spread into `app.inject`.
 */
export function multipartPayload(
  fields: Record<string, string>,
  file: { filename: string; contentType: string; body: Buffer },
) {
  const boundary = MULTIPART_BOUNDARY;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(file.body);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}
