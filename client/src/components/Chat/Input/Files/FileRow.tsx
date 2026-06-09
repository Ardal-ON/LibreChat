import { useEffect, useMemo } from 'react';
import { useToastContext } from '@librechat/client';
import { dataService, EToolResources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { useDeleteFilesMutation } from '~/data-provider';
import { useFilePreview } from '~/data-provider';
import { logger, getCachedPreview, triggerDownload } from '~/utils';
import { useFileDeletion } from '~/hooks/Files';
import { useAuthContext } from '~/hooks/AuthContext';
import FileContainer from './FileContainer';
import { useLocalize } from '~/hooks';
import Image from './Image';

function FileLifecycleSync({
  file,
  setFiles,
}: {
  file: ExtendedFile;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
}) {
  const enabled = file.status === 'pending' && !!file.file_id;
  const preview = useFilePreview(file.file_id, { enabled });

  useEffect(() => {
    const data = preview.data;
    if (!data || data.status === 'pending') {
      return;
    }

    setFiles((currentFiles) => {
      const updatedFiles = new Map(currentFiles);
      const directFile = updatedFiles.get(file.file_id);
      const matchedFile = directFile
        ? ([file.file_id, directFile] as const)
        : Array.from(updatedFiles.entries()).find(
            ([, currentFile]) => currentFile.file_id === file.file_id,
          );
      if (!matchedFile) {
        return currentFiles;
      }
      const [fileKey, current] = matchedFile;
      if (!current) {
        return currentFiles;
      }
      const nextType = data.status === 'ready' ? 'text/markdown' : current.type;
      if (
        current.progress === 1 &&
        current.status === data.status &&
        current.previewError === data.previewError &&
        current.type === nextType
      ) {
        return currentFiles;
      }
      updatedFiles.set(fileKey, {
        ...current,
        progress: 1,
        status: data.status,
        previewError: data.previewError,
        type: nextType,
      });
      return updatedFiles;
    });
  }, [file.file_id, preview.data, setFiles]);

  return null;
}

export default function FileRow({
  files: _files,
  setFiles,
  abortUpload,
  setFilesLoading,
  assistant_id,
  agent_id,
  tool_resource,
  fileFilter,
  isRTL = false,
  Wrapper,
}: {
  files: Map<string, ExtendedFile> | undefined;
  abortUpload?: () => void;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  fileFilter?: (file: ExtendedFile) => boolean;
  assistant_id?: string;
  agent_id?: string;
  tool_resource?: EToolResources;
  isRTL?: boolean;
  Wrapper?: React.FC<{ children: React.ReactNode }>;
}) {
  const localize = useLocalize();
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const files = useMemo(
    () =>
      Array.from(_files?.values() ?? []).filter((file) => (fileFilter ? fileFilter(file) : true)),
    [_files, fileFilter],
  );

  const { mutateAsync } = useDeleteFilesMutation({
    onMutate: async () =>
      logger.log(
        'agents',
        'Deleting files: agent_id, assistant_id, tool_resource',
        agent_id,
        assistant_id,
        tool_resource,
      ),
    onSuccess: () => {
      console.log('Files deleted');
    },
    onError: (error) => {
      console.log('Error deleting files:', error);
    },
  });

  const { deleteFile } = useFileDeletion({ mutateAsync, agent_id, assistant_id, tool_resource });

  useEffect(() => {
    if (!setFilesLoading) return;
    const isLoading =
      files.length > 0 && files.some((file) => file.progress < 1 && file.status !== 'pending');
    setFilesLoading((current) => (current === isLoading ? current : isLoading));
  }, [files, setFilesLoading]);

  if (files.length === 0) {
    return null;
  }

  const renderFiles = () => {
    const rowStyle = isRTL
      ? {
          display: 'flex',
          flexDirection: 'row-reverse',
          flexWrap: 'wrap',
          gap: '4px',
          width: '100%',
          maxWidth: '100%',
        }
      : {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px',
          width: '100%',
          maxWidth: '100%',
        };

    return (
      <div style={rowStyle as React.CSSProperties}>
        {files
          .reduce(
            (acc, current) => {
              if (!acc.map.has(current.file_id)) {
                acc.map.set(current.file_id, true);
                acc.uniqueFiles.push(current);
              }
              return acc;
            },
            { map: new Map(), uniqueFiles: [] as ExtendedFile[] },
          )
          .uniqueFiles.map((file: ExtendedFile, index: number) => {
            const handleDelete = () => {
              if (abortUpload && file.progress < 1) {
                abortUpload();
              }
              if (file.progress >= 1 && !file.attached) {
                showToast({
                  message: localize('com_ui_deleting_file'),
                  status: 'info',
                });
              }
              deleteFile({ file, setFiles });
            };
            const isImage = file.type?.startsWith('image') ?? false;
            const waitingForOCR = 'Waiting for OCR...';
            const ocrFailed = file.previewError || 'OCR failed';
            let subtitle: React.ReactNode;
            if (file.status === 'pending') {
              subtitle = (
                <div className="truncate text-text-secondary" title={waitingForOCR}>
                  {waitingForOCR}
                </div>
              );
            } else if (file.status === 'failed') {
              subtitle = (
                <div className="truncate text-red-500" title={ocrFailed}>
                  {ocrFailed}
                </div>
              );
            }
            const handleDownload = async (event: React.MouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              if (file.status === 'pending' || !user?.id || !file.file_id) {
                return;
              }
              try {
                const response = await dataService.getFileDownload(user.id, file.file_id);
                const downloadURL = window.URL.createObjectURL(response.data);
                triggerDownload(downloadURL, file.filename || 'download');
              } catch (error) {
                logger.error('Error downloading uploaded file:', error);
                showToast({
                  status: 'error',
                  message: 'Error downloading file',
                });
              }
            };

            return (
              <div
                key={index}
                style={{
                  flexBasis: '70px',
                  flexGrow: 0,
                  flexShrink: 0,
                }}
              >
                <FileLifecycleSync file={file} setFiles={setFiles} />
                {isImage ? (
                  <Image
                    url={getCachedPreview(file.file_id) ?? file.preview ?? file.filepath}
                    onDelete={handleDelete}
                    progress={file.progress}
                    source={file.source}
                  />
                ) : (
                  <FileContainer
                    file={file}
                    onDelete={handleDelete}
                    onClick={handleDownload}
                    subtitle={subtitle}
                  />
                )}
              </div>
            );
          })}
      </div>
    );
  };

  if (Wrapper) {
    return <Wrapper>{renderFiles()}</Wrapper>;
  }

  return renderFiles();
}
