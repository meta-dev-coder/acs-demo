/**
 * TEMPORARY DataConnect token intake lambda (Function URL). Logic lives in intake.mjs.
 *
 * Environment variables:
 *   DC_TOKEN_BUCKET            — data bucket; the token is stored at secrets/dc-token.txt
 *   DC_TOKEN_KMS_KEY_ARN       — dedicated KMS key for SSE-KMS (CloudFront's OAC cannot decrypt it)
 *   DC_PERMISSION_URL          — DataConnect user-mgmt permission endpoint (must grant dcm-admin)
 *   DC_TOKEN_ALLOWED_SUBJECTS  — optional comma list of JWT sub/email values
 *   DC_TOKEN_ALLOWED_ORIGINS   — comma list of browser origins given CORS headers
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createIntakeHandler, loadIntakeConfig } from './intake.mjs';

const s3 = new S3Client({});

export const handler = createIntakeHandler({
  config: loadIntakeConfig(process.env),
  putObject: params => s3.send(new PutObjectCommand(params)),
});
