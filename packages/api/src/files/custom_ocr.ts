import fs from 'fs';
import path from 'path';
import axios, { type AxiosRequestConfig } from 'axios';
import FormData from 'form-data';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { FileSources, envVarRegex, extractVariableName } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { logAxiosError } from '~/utils/axios';

interface AuthConfig {
  apiKey: string;
  baseURL: string;
}

interface CustomOCRContext {
  req: ServerRequest;
  file: Express.Multer.File;
  loadAuthValues: (params: {
    userId: string;
    authFields: string[];
    optional?: Set<string>;
  }) => Promise<Record<string, string | undefined>>;
}

export interface CustomOCRPendingResult {
  filename: string;
  bytes: number;
  filepath: FileSources.custom_ocr;
  text: string;
  images: string[];
  pending: true;
  call_id: string;
  provider: 'custom_ocr';
  originalFilename: string;
  originalMime: string;
}

export type CustomOCRPollResult =
  | { status: 'pending' }
  | {
      status: 'ready';
      markdown: string;
      bytes: number;
      job_id?: string;
      filename?: string;
      warnings?: unknown;
    }
  | { status: 'failed'; error: string; job_id?: string };

function needsEnvLoad(value: string): boolean {
  return envVarRegex.test(value) || !value.trim();
}

function getEnvVarName(configValue: string, defaultName: string): string {
  if (!envVarRegex.test(configValue)) {
    return defaultName;
  }
  return extractVariableName(configValue) || defaultName;
}

async function resolveConfigValue(
  configValue: string,
  defaultEnvName: string,
  authValues: Record<string, string | undefined>,
  defaultValue = '',
): Promise<string> {
  if (!needsEnvLoad(configValue)) {
    return configValue;
  }
  const envVarName = getEnvVarName(configValue, defaultEnvName);
  return authValues[envVarName] || defaultValue;
}

async function loadCustomOCRAuthConfig(context: {
  req: ServerRequest;
  loadAuthValues: CustomOCRContext['loadAuthValues'];
}): Promise<AuthConfig> {
  const ocrConfig: TCustomConfig['ocr'] | undefined = context.req.config?.ocr;
  const apiKeyConfig = ocrConfig?.apiKey || '';
  const baseURLConfig = ocrConfig?.baseURL || '';

  if (!needsEnvLoad(apiKeyConfig) && !needsEnvLoad(baseURLConfig)) {
    return { apiKey: apiKeyConfig, baseURL: baseURLConfig };
  }

  const authFields: string[] = [];
  if (needsEnvLoad(baseURLConfig)) {
    authFields.push(getEnvVarName(baseURLConfig, 'OCR_BASEURL'));
  }
  if (needsEnvLoad(apiKeyConfig)) {
    authFields.push(getEnvVarName(apiKeyConfig, 'OCR_API_KEY'));
  }

  const authValues = await context.loadAuthValues({
    userId: context.req.user?.id || '',
    authFields,
    optional: new Set(['OCR_API_KEY']),
  });

  const apiKey = await resolveConfigValue(apiKeyConfig, 'OCR_API_KEY', authValues);
  const baseURL = await resolveConfigValue(baseURLConfig, 'OCR_BASEURL', authValues);
  if (!baseURL.trim()) {
    throw new Error('Custom OCR baseURL is required. Set ocr.baseURL or OCR_BASEURL.');
  }
  return { apiKey, baseURL };
}

function modalEndpoint(baseURL: string, pathSuffix: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (trimmed.endsWith(pathSuffix)) {
    return trimmed;
  }
  if (pathSuffix === '/api/parse' && trimmed.endsWith('/api')) {
    return `${trimmed}/parse`;
  }
  if (pathSuffix.startsWith('/api/') && trimmed.endsWith('/api')) {
    return `${trimmed}${pathSuffix.slice('/api'.length)}`;
  }
  return `${trimmed}${pathSuffix}`;
}

function axiosConfig(apiKey: string): AxiosRequestConfig {
  const config: AxiosRequestConfig = {
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    headers: {},
  };
  if (apiKey) {
    config.headers = { Authorization: `Bearer ${apiKey}` };
  }
  if (process.env.PROXY) {
    config.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
  }
  return config;
}

function markdownFilename(filename: string): string {
  const parsed = path.parse(filename);
  const stem = parsed.name || filename || 'document';
  return `${stem}.md`;
}

export async function uploadCustomOCR(context: CustomOCRContext): Promise<CustomOCRPendingResult> {
  try {
    const { apiKey, baseURL } = await loadCustomOCRAuthConfig(context);
    const form = new FormData();
    const filename = context.file.originalname || path.basename(context.file.path);
    form.append('file', fs.createReadStream(context.file.path), { filename });

    const config = axiosConfig(apiKey);
    config.headers = {
      ...config.headers,
      ...form.getHeaders(),
    };

    const response = await axios.post(modalEndpoint(baseURL, '/api/parse'), form, config);
    const callId = response.data?.call_id ?? response.data?.files?.[0]?.call_id;
    if (!callId || typeof callId !== 'string') {
      throw new Error('Custom OCR service did not return call_id');
    }

    return {
      filename: markdownFilename(filename),
      bytes: 0,
      filepath: FileSources.custom_ocr,
      text: '',
      images: [],
      pending: true,
      call_id: callId,
      provider: 'custom_ocr',
      originalFilename: filename,
      originalMime: context.file.mimetype || '',
    };
  } catch (error) {
    const message = logAxiosError({ error, message: 'Error submitting file to custom OCR:' });
    throw new Error(message);
  }
}

export async function pollCustomOCRResult({
  req,
  call_id,
  loadAuthValues,
}: {
  req: ServerRequest;
  call_id: string;
  loadAuthValues: CustomOCRContext['loadAuthValues'];
}): Promise<CustomOCRPollResult> {
  try {
    const { apiKey, baseURL } = await loadCustomOCRAuthConfig({ req, loadAuthValues });
    const url = modalEndpoint(baseURL, `/api/result/${encodeURIComponent(call_id)}`);
    const response = await axios.get(url, {
      ...axiosConfig(apiKey),
      validateStatus: (status) => (status >= 200 && status < 300) || status === 404,
      timeout: 30000,
    });

    if (response.status === 202) {
      return { status: 'pending' };
    }
    if (response.status === 404) {
      return { status: 'failed', error: 'expired' };
    }

    const data = response.data ?? {};
    if (data.status === 'failed' || data.error) {
      return {
        status: 'failed',
        error: String(data.error || data.detail || 'custom-ocr-failed'),
        job_id: data.job_id,
      };
    }

    const markdown = data.markdown;
    if (typeof markdown !== 'string') {
      return { status: 'failed', error: 'missing-markdown', job_id: data.job_id };
    }

    return {
      status: 'ready',
      markdown,
      bytes: Buffer.byteLength(markdown, 'utf8'),
      job_id: data.job_id,
      filename: data.filename,
      warnings: data.warnings,
    };
  } catch (error) {
    const message = logAxiosError({
      error,
      message: 'Error polling custom OCR result:',
    });
    return { status: 'failed', error: message };
  }
}
