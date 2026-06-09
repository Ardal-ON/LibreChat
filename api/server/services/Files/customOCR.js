const axios = require('axios');
const { logger } = require('@librechat/data-schemas');
const { FileSources } = require('librechat-data-provider');
const { generateShortLivedToken, logAxiosError, pollCustomOCRResult } = require('@librechat/api');
const { loadAuthValues } = require('~/server/services/Tools/credentials');

const isCustomOCRPendingFile = (file) =>
  file?.status === 'pending' &&
  file?.metadata?.ocr?.provider === FileSources.custom_ocr &&
  typeof file?.metadata?.ocr?.call_id === 'string' &&
  file.metadata.ocr.call_id.length > 0;

const shortError = (error) => String(error?.message || error || 'custom-ocr-failed').slice(0, 200);

async function ingestGraphRAG({ req, file, text, filename }) {
  if (!process.env.GRAPH_RAG_API_URL || !text) {
    return { status: 'skipped' };
  }

  try {
    const jwtToken = generateShortLivedToken(req.user.id);
    const response = await axios.post(
      `${process.env.GRAPH_RAG_API_URL}/ingest-text`,
      {
        file_id: file.file_id,
        filename,
        text,
        entity_id: file.metadata?.ocr?.entity_id,
      },
      {
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
      },
    );

    return {
      status: 'ready',
      chunk_count: response.data?.chunk_count,
      ingestedAt: new Date(),
    };
  } catch (error) {
    logAxiosError({ error, message: 'Error ingesting custom OCR markdown into GraphRAG' });
    return {
      status: 'failed',
      error: shortError(error),
    };
  }
}

async function finalizeCustomOCRFile({ req, file, db }) {
  if (!isCustomOCRPendingFile(file)) {
    return file;
  }

  const callId = file.metadata.ocr.call_id;
  const result = await pollCustomOCRResult({
    req,
    call_id: callId,
    loadAuthValues,
  });

  if (result.status === 'pending') {
    return file;
  }

  const ocrMetadata = {
    ...(file.metadata?.ocr ?? {}),
    job_id: result.job_id ?? file.metadata?.ocr?.job_id,
  };

  if (result.status === 'failed') {
    const failed = await db.updateFile(
      {
        file_id: file.file_id,
        status: 'failed',
        previewError: shortError(result.error),
        metadata: {
          ...(file.metadata ?? {}),
          ocr: {
            ...ocrMetadata,
            failedAt: new Date(),
            error: shortError(result.error),
          },
        },
      },
      { status: 'pending' },
    );
    return failed ?? file;
  }

  const markdownFilename =
    file.filename?.endsWith('.md') || file.filename?.endsWith('.markdown')
      ? file.filename
      : `${file.filename || file.metadata?.ocr?.originalFilename || 'document'}.md`;

  const graphRAG = await ingestGraphRAG({
    req,
    file,
    text: result.markdown,
    filename: markdownFilename,
  });

  const ready = await db.updateFile(
    {
      file_id: file.file_id,
      status: 'ready',
      previewError: undefined,
      text: result.markdown,
      textFormat: 'text',
      bytes: result.bytes,
      type: 'text/markdown',
      filename: markdownFilename,
      filepath: FileSources.custom_ocr,
      source: FileSources.text,
      metadata: {
        ...(file.metadata ?? {}),
        ocr: {
          ...ocrMetadata,
          completedAt: new Date(),
          graphrag: graphRAG,
        },
      },
    },
    { status: 'pending' },
  );

  if (ready) {
    logger.info(`[custom_ocr] Finalized OCR markdown for file ${file.file_id}`);
  }
  return ready ?? file;
}

module.exports = {
  finalizeCustomOCRFile,
  isCustomOCRPendingFile,
};
