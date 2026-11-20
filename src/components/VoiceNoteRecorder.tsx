import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Mic,
  Square,
  Trash2,
  Loader2,
  AlertCircle,
  Volume2,
  X,
} from 'lucide-react';
import type { VoiceNote } from '../types/autopatch';
import { PANEL_TRANSITION } from '../utils/motionPresets';

interface VoiceNoteRecorderProps {
  findingId: string;
  filename: string;
  line: number;
  bugTitle: string;
  notes: VoiceNote[];
  onAddNote: (note: VoiceNote) => void;
  onUpdateNote: (noteId: string, patch: Partial<VoiceNote>) => void;
  onDeleteNote: (noteId: string) => void;
}

function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function formatDuration(sec: number): string {
  const whole = Math.max(0, Math.round(sec));
  const mins = Math.floor(whole / 60);
  const rem = whole % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function VoiceNoteRecorder({
  findingId,
  filename,
  line,
  bugTitle,
  notes,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
}: VoiceNoteRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef<number>(0);
  const cancelledRef = useRef<boolean>(false);

  const cleanupMediaResources = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    setMicLevel(0);
  };

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore stop errors on unmount
        }
      }
      cleanupMediaResources();
    };
  }, []);

  const handleStartRecording = async () => {
    setMicError(null);

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof MediaRecorder === 'undefined'
    ) {
      setMicError(
        'Microphone recording is not supported in this browser environment.'
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      cancelledRef.current = false;

      const mimeType = pickSupportedMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      // Live audio level meter via Web Audio AnalyserNode
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const updateLevel = () => {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const avg = sum / Math.max(1, dataArray.length);
            setMicLevel(Math.min(100, Math.round((avg / 128) * 100)));
            rafRef.current = window.requestAnimationFrame(updateLevel);
          };
          updateLevel();
        }
      } catch {
        // Level meter is non-critical; continue recording cleanly
      }

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const durationSec = Math.max(
          1,
          Math.round((Date.now() - startTimeRef.current) / 1000)
        );
        const finalMime = recorder.mimeType || mimeType || 'audio/webm';
        const wasCancelled = cancelledRef.current;
        const recordedChunks = [...chunksRef.current];
        cleanupMediaResources();
        setIsRecording(false);
        setElapsedSec(0);

        if (wasCancelled || recordedChunks.length === 0) return;

        const blob = new Blob(recordedChunks, { type: finalMime });
        const reader = new FileReader();
        reader.onloadend = async () => {
          if (typeof reader.result !== 'string') return;
          const audioDataUrl = reader.result;
          const noteId = `vn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

          const newNote: VoiceNote = {
            id: noteId,
            findingId,
            filename,
            line,
            bugTitle,
            createdAt: new Date().toISOString(),
            durationSec,
            mimeType: finalMime,
            audioDataUrl,
            transcript: '',
            transcriptionStatus: 'transcribing',
          };
          onAddNote(newNote);

          try {
            const res = await fetch('/api/transcribe-note', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                audioDataUrl,
                mimeType: finalMime,
                bugContext: `${filename} line ${line}: ${bugTitle}`,
              }),
            });
            const data = await res.json();
            if (!res.ok) {
              throw new Error(data.error || 'Transcription unavailable.');
            }
            onUpdateNote(noteId, {
              transcript: data.transcript || '',
              transcriptionStatus: 'completed',
            });
          } catch (err) {
            onUpdateNote(noteId, {
              transcriptionStatus: 'failed',
              transcriptionError:
                err instanceof Error
                  ? err.message
                  : 'Automatic transcription unavailable.',
            });
          }
        };
        reader.readAsDataURL(blob);
      };

      startTimeRef.current = Date.now();
      setElapsedSec(0);
      setIsRecording(true);
      recorder.start(250);

      timerRef.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 250);
    } catch (err) {
      cleanupMediaResources();
      setIsRecording(false);
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setMicError(
          'Microphone permission was denied. Allow microphone access in your browser to record voice notes.'
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setMicError('No microphone device was found on this system.');
      } else {
        setMicError(
          err instanceof Error ? err.message : 'Unable to start microphone recording.'
        );
      }
    }
  };

  const handleStopRecording = () => {
    cancelledRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleCancelRecording = () => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else {
      cleanupMediaResources();
      setIsRecording(false);
      setElapsedSec(0);
    }
  };

  return (
    <div className="pt-3 border-t border-white/10 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-[#F4F7FF]">
          <Volume2 className="w-3.5 h-3.5 text-[#50D7E6]" aria-hidden="true" />
          <span>Developer Voice Notes ({notes.length})</span>
          <span className="font-normal text-[#A6B0C8] hidden sm:inline">
            · Document why you edited or kept this code
          </span>
        </div>

        {!isRecording ? (
          <button
            type="button"
            onClick={handleStartRecording}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#F4F7FF] bg-white/8 hover:bg-white/14 border border-white/15 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Mic className="w-3.5 h-3.5 text-[#FF718B]" aria-hidden="true" />
            <span>Record Voice Note</span>
          </button>
        ) : (
          <div className="flex items-center gap-2">
            {/* Live mic level meter + elapsed timer */}
            <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-[#FF718B]/15 border border-[#FF718B]/35 rounded-lg">
              <span className="font-mono text-xs font-semibold tabular-nums text-[#FF718B]">
                REC {formatDuration(elapsedSec)}
              </span>
              <div
                aria-hidden="true"
                className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden"
              >
                <div
                  className="h-full bg-[#FF718B] transition-[width] duration-75"
                  style={{ width: `${Math.max(8, micLevel)}%` }}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleStopRecording}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-[#FF718B] hover:bg-[#ff5876] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Square className="w-3 h-3 fill-current" aria-hidden="true" />
              <span>Stop &amp; Save</span>
            </button>
            <button
              type="button"
              onClick={handleCancelRecording}
              aria-label="Cancel voice recording"
              className="inline-flex items-center justify-center w-8 h-8 text-[#A6B0C8] hover:text-[#F4F7FF] rounded-lg hover:bg-white/10 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {micError && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 bg-[#FF718B]/12 border border-[#FF718B]/35 rounded-lg text-xs text-[#FF718B]"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>{micError}</span>
        </div>
      )}

      <AnimatePresence initial={false}>
        {notes.length > 0 && (
          <motion.ul
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={PANEL_TRANSITION}
            className="space-y-2"
          >
            {notes.map((note) => (
              <motion.li
                key={note.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={PANEL_TRANSITION}
                className="p-2.5 bg-[#0B1020]/70 border border-white/10 rounded-lg space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[11px] font-mono text-[#A6B0C8] tabular-nums">
                    <span>{formatDuration(note.durationSec)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {new Date(note.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {note.transcriptionStatus === 'transcribing' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 font-sans text-[#50D7E6]">
                          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                          <span>Transcribing...</span>
                        </span>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onDeleteNote(note.id)}
                    aria-label="Delete voice note"
                    className="inline-flex items-center gap-1 text-[11px] text-[#A6B0C8] hover:text-[#FF718B] cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" aria-hidden="true" />
                    <span>Delete</span>
                  </button>
                </div>

                <audio
                  controls
                  preload="metadata"
                  src={note.audioDataUrl}
                  className="w-full h-8"
                />

                <div className="space-y-1">
                  <label
                    htmlFor={`note-transcript-${note.id}`}
                    className="block text-[11px] font-medium text-[#A6B0C8]"
                  >
                    Reasoning Note / Transcript
                  </label>
                  <textarea
                    id={`note-transcript-${note.id}`}
                    value={note.transcript}
                    onChange={(e) =>
                      onUpdateNote(note.id, {
                        transcript: e.target.value,
                        transcriptionStatus:
                          note.transcriptionStatus === 'transcribing'
                            ? 'manual'
                            : note.transcriptionStatus,
                      })
                    }
                    rows={2}
                    placeholder={
                      note.transcriptionStatus === 'transcribing'
                        ? 'Transcribing audio...'
                        : note.transcriptionError
                        ? `${note.transcriptionError} Type your reasoning note here if needed.`
                        : 'Add or edit reasoning notes for this bug...'
                    }
                    className="w-full px-2.5 py-1.5 text-xs text-[#F4F7FF] placeholder:text-[#A6B0C8]/70 bg-[#070B16]/85 border border-white/12 rounded-md focus:outline-none focus:border-[#8B7CFF] resize-y"
                  />
                </div>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
