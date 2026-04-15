/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Upload, 
  Scissors, 
  Crop, 
  Download, 
  Trash2, 
  Play, 
  Pause, 
  Maximize, 
  Minimize,
  Scan,
  Clipboard,
  FileVideo,
  Eye,
  EyeOff,
  RefreshCcw,
  Undo2,
  Redo2,
  Repeat,
  Copy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { cn } from './lib/utils';

// --- Types ---

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TrimRange {
  start: number;
  end: number;
}

// --- Components ---

export default function App() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [trimRange, setTrimRange] = useState<TrimRange>({ start: 0, end: 0 });
  const [cropArea, setCropArea] = useState<CropArea>({ x: 0, y: 0, width: 100, height: 100 });
  const [isCropping, setIsCropping] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoMetadata, setVideoMetadata] = useState({ width: 0, height: 0 });
  
  // High-performance timeline drag state
  const [timelineDragState, setTimelineDragState] = useState<'start' | 'end' | 'playhead' | null>(null);
  
  const [isLooping, setIsLooping] = useState(false);
  const [outputScale, setOutputScale] = useState(100);
  
  // History for Undo/Redo
  const [history, setHistory] = useState<{ trim: TrimRange; crop: CropArea }[]>([]);
  const [redoStack, setRedoStack] = useState<{ trim: TrimRange; crop: CropArea }[]>([]);

  // Resize state
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Preload FFmpeg in background
    loadFFmpeg().catch(console.error);

    // Handle paste from buffer
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('video') !== -1) {
            const file = items[i].getAsFile();
            if (file) handleFile(file);
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const addToHistory = useCallback((trim: TrimRange, crop: CropArea) => {
    setHistory(prev => {
      const last = prev[prev.length - 1];
      if (last && last.trim.start === trim.start && last.trim.end === trim.end && 
          last.crop.x === crop.x && last.crop.y === crop.y && 
          last.crop.width === crop.width && last.crop.height === crop.height) {
        return prev;
      }
      return [...prev, { trim: { ...trim }, crop: { ...crop } }].slice(-50);
    });
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    if (history.length <= 1) return;
    const current = history[history.length - 1];
    const previous = history[history.length - 2];
    
    setRedoStack(prev => [...prev, current]);
    setHistory(prev => prev.slice(0, -1));
    setTrimRange(previous.trim);
    setCropArea(previous.crop);
  }, [history]);

  const redo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    
    setHistory(prev => [...prev, next]);
    setRedoStack(prev => prev.slice(0, -1));
    setTrimRange(next.trim);
    setCropArea(next.crop);
  }, [redoStack]);

  const togglePlay = useCallback(() => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        const end = Math.max(trimRange.start, trimRange.end);
        if (videoRef.current.currentTime >= end - 0.05) {
          const start = Math.min(trimRange.start, trimRange.end);
          videoRef.current.currentTime = start;
        }
        videoRef.current.play();
      } else {
        videoRef.current.pause();
      }
    }
  }, [trimRange]);

  const seekTo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === 'b') {
        setTrimRange(prev => ({ ...prev, start: currentTime }));
        addToHistory({ ...trimRange, start: currentTime }, cropArea);
      } else if (e.key.toLowerCase() === 'n') {
        setTrimRange(prev => ({ ...prev, end: currentTime }));
        addToHistory({ ...trimRange, end: currentTime }, cropArea);
      } else if (e.ctrlKey && e.key === 'z') {
        e.preventDefault();
        undo();
      } else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isPlaying, currentTime, undo, redo, trimRange, cropArea, addToHistory, togglePlay]);

  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    
    ffmpegRef.current = ffmpeg;
    return ffmpeg;
  };

  // --- Handlers ---

  const handleFile = (file: File) => {
    if (file.type.startsWith('video/')) {
      setVideoFile(file);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);
      setIsPlaying(false);
      setCurrentTime(0);
      const initialCrop = { x: 0, y: 0, width: 100, height: 100 };
      setCropArea(initialCrop);
      setIsPreviewMode(false);
      setHistory([{ trim: { start: 0, end: 0 }, crop: initialCrop }]);
      setRedoStack([]);
      
      // Focus the video element to ensure spacebar works immediately
      setTimeout(() => {
        videoRef.current?.focus();
      }, 100);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleMetadataLoaded = () => {
    if (videoRef.current) {
      const d = videoRef.current.duration;
      setDuration(d);
      const initialTrim = { start: 0, end: d };
      setTrimRange(initialTrim);
      setVideoMetadata({
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight
      });
      setHistory([{ trim: initialTrim, crop: { x: 0, y: 0, width: 100, height: 100 } }]);
    }
  };
  
  useEffect(() => {
    let animationFrameId: number;
    
    const updatePlayhead = () => {
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
      }
      animationFrameId = requestAnimationFrame(updatePlayhead);
    };

    if (isPlaying) {
      animationFrameId = requestAnimationFrame(updatePlayhead);
    }

    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying]);

  useEffect(() => {
    if (isPlaying && videoRef.current) {
      const start = Math.min(trimRange.start, trimRange.end);
      const end = Math.max(trimRange.start, trimRange.end);
      
      if (currentTime >= end) {
        if (isLooping) {
          seekTo(start);
        } else {
          videoRef.current.pause();
          setIsPlaying(false);
        }
      }
    }
  }, [currentTime, isPlaying, isLooping, trimRange, seekTo]);

  // --- High-Performance Timeline Pointer Handlers ---

  const handleTimelinePointerDown = (e: React.PointerEvent, type: 'start' | 'end' | 'playhead') => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!timelineRef.current || duration === 0) return;

    let actualType = type;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = Math.max(0, Math.min(duration, (x / rect.width) * duration));

    // Support right click anywhere on track to fast-set 'end' point
    if (type === 'playhead' && e.button === 2) {
      actualType = 'end';
      setTrimRange(prev => ({ ...prev, end: time }));
    } else if (type === 'playhead' && e.button === 0) {
      seekTo(time);
    } else if (e.button !== 0) {
      return;
    }

    e.currentTarget.setPointerCapture(e.pointerId);
    setTimelineDragState(actualType);
  };

  const handleTimelinePointerMove = (e: React.PointerEvent) => {
    if (!timelineDragState || !timelineRef.current || duration === 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = Math.max(0, Math.min(duration, (x / rect.width) * duration));

    if (timelineDragState === 'playhead') {
      seekTo(time);
    } else if (timelineDragState === 'start') {
      setTrimRange(prev => ({ ...prev, start: time }));
    } else if (timelineDragState === 'end') {
      setTrimRange(prev => ({ ...prev, end: time }));
    }
  };

  const handleTimelinePointerUp = (e: React.PointerEvent) => {
    if (!timelineDragState) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (timelineDragState === 'start' || timelineDragState === 'end') {
      addToHistory(trimRange, cropArea);
    }
    setTimelineDragState(null);
  };


  // --- Cropping Logic ---

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    
    // Check if clicking a handle
    const target = e.target as HTMLElement;
    const handle = target.getAttribute('data-handle');
    if (handle) {
      setResizeHandle(handle);
      return;
    }

    if (!isCropping) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    dragStartPos.current = { x, y };
    setCropArea({ x, y, width: 0, height: 0 });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    if (resizeHandle) {
      const currentX = ((e.clientX - rect.left) / rect.width) * 100;
      const currentY = ((e.clientY - rect.top) / rect.height) * 100;
      
      setCropArea(prev => {
        let { x, y, width, height } = { ...prev };
        const right = x + width;
        const bottom = y + height;

        if (resizeHandle.includes('e')) width = Math.max(1, currentX - x);
        if (resizeHandle.includes('w')) {
          const newX = Math.min(currentX, right - 1);
          width = right - newX;
          x = newX;
        }
        if (resizeHandle.includes('s')) height = Math.max(1, currentY - y);
        if (resizeHandle.includes('n')) {
          const newY = Math.min(currentY, bottom - 1);
          height = bottom - newY;
          y = newY;
        }

        return {
          x: Math.max(0, x),
          y: Math.max(0, y),
          width: Math.min(100 - x, width),
          height: Math.min(100 - y, height)
        };
      });
      return;
    }

    if (!isCropping || !dragStartPos.current) return;
    
    const currentX = ((e.clientX - rect.left) / rect.width) * 100;
    const currentY = ((e.clientY - rect.top) / rect.height) * 100;

    const x = Math.min(dragStartPos.current.x, currentX);
    const y = Math.min(dragStartPos.current.y, currentY);
    const width = Math.abs(dragStartPos.current.x - currentX);
    const height = Math.abs(dragStartPos.current.y - currentY);

    setCropArea({
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: Math.min(100 - x, width),
      height: Math.min(100 - y, height)
    });
  };

  const handleMouseUp = () => {
    if (dragStartPos.current || resizeHandle) {
      addToHistory(trimRange, cropArea);
    }
    dragStartPos.current = null;
    setResizeHandle(null);
  };

  const resetCrop = () => {
    const newCrop = { x: 0, y: 0, width: 100, height: 100 };
    setCropArea(newCrop);
    addToHistory(trimRange, newCrop);
  };

  // --- Auto-detect Bars ---

  const detectBars = useCallback(() => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    
    // Optimization: Use a small proxy canvas for analysis (much faster than full res)
    const analysisWidth = 320;
    const analysisHeight = Math.round((video.videoHeight / video.videoWidth) * analysisWidth);
    canvas.width = analysisWidth;
    canvas.height = analysisHeight;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Robust luminance-based detection
    const isBlackOrWhite = (r: number, g: number, b: number) => {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 40 || lum > 215; // Slightly tighter for accuracy
    };

    // Check if a row/column is mostly empty (bars)
    const isLineEmpty = (lineIdx: number, isRow: boolean) => {
      let emptyCount = 0;
      const length = isRow ? canvas.width : canvas.height;
      
      // Sample every pixel on the small canvas (it's only 320px, so it's fast)
      for (let i = 0; i < length; i++) {
        const x = isRow ? i : lineIdx;
        const y = isRow ? lineIdx : i;
        const idx = (y * canvas.width + x) * 4;
        if (isBlackOrWhite(data[idx], data[idx + 1], data[idx + 2])) {
          emptyCount++;
        }
      }
      return emptyCount / length > 0.92; // 92% threshold
    };

    let top = 0, bottom = canvas.height - 1, left = 0, right = canvas.width - 1;

    // Scan from top
    for (let y = 0; y < canvas.height; y++) {
      if (!isLineEmpty(y, true)) {
        top = y;
        break;
      }
    }

    // Scan from bottom
    for (let y = canvas.height - 1; y >= 0; y--) {
      if (!isLineEmpty(y, true)) {
        bottom = y;
        break;
      }
    }

    // Scan from left
    for (let x = 0; x < canvas.width; x++) {
      if (!isLineEmpty(x, false)) {
        left = x;
        break;
      }
    }

    // Scan from right
    for (let x = canvas.width - 1; x >= 0; x--) {
      if (!isLineEmpty(x, false)) {
        right = x;
        break;
      }
    }

    const newCrop = {
      x: (left / canvas.width) * 100,
      y: (top / canvas.height) * 100,
      width: ((right - left) / canvas.width) * 100,
      height: ((bottom - top) / canvas.height) * 100
    };
    
    // Ensure we don't set invalid dimensions
    if (newCrop.width <= 0) newCrop.width = 100;
    if (newCrop.height <= 0) newCrop.height = 100;

    setCropArea(newCrop);
    addToHistory(trimRange, newCrop);
  }, [trimRange, addToHistory]);

  // --- Export ---

  const exportVideo = async () => {
    if (!videoFile) return;
    setIsProcessing(true);
    setProgress(0);

    try {
      const ffmpeg = await loadFFmpeg();
      const inputName = 'input.mp4';
      const outputName = 'output.mp4';

      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      // Calculate crop parameters
      const cropW = Math.floor((cropArea.width / 100) * videoMetadata.width);
      const cropH = Math.floor((cropArea.height / 100) * videoMetadata.height);
      const cropX = Math.floor((cropArea.x / 100) * videoMetadata.width);
      const cropY = Math.floor((cropArea.y / 100) * videoMetadata.height);

      // Ensure crop dimensions are even for libx264
      const evenCropW = Math.floor(cropW / 2) * 2;
      const evenCropH = Math.floor(cropH / 2) * 2;

      let filter = `crop=${evenCropW}:${evenCropH}:${cropX}:${cropY}`;
      if (outputScale !== 100) {
        const scaleW = Math.floor((evenCropW * (outputScale / 100)) / 2) * 2;
        const scaleH = Math.floor((evenCropH * (outputScale / 100)) / 2) * 2;
        filter += `,scale=${scaleW}:${scaleH}`;
      }
      
      const startTime = Math.min(trimRange.start, trimRange.end).toFixed(2);
      const durationVal = Math.abs(trimRange.end - trimRange.start).toFixed(2);
      const durationNum = parseFloat(durationVal);

      // Progress handler using logs for more accuracy with trimmed videos
      const logHandler = ({ message }: { message: string }) => {
        const timeMatch = message.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch && durationNum > 0) {
          const timeStr = timeMatch[1];
          const parts = timeStr.split(':');
          const seconds = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
          const p = Math.min(99, Math.round((seconds / durationNum) * 100));
          setProgress(p);
        }
      };

      ffmpeg.on('log', logHandler);

      await ffmpeg.exec([
        '-ss', startTime,
        '-t', durationVal,
        '-i', inputName,
        '-vf', filter,
        '-preset', 'ultrafast',
        '-c:v', 'libx264',
        '-crf', '23',
        '-c:a', 'copy',
        outputName
      ]);

      ffmpeg.off('log', logHandler);
      setProgress(100);

      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited_${videoFile.name}`;
      a.click();
      
    } catch (error) {
      console.error('Export failed:', error);
      alert('Failed to export video. Check console for details.');
    } finally {
      setIsProcessing(false);
    }
  };

  // --- Render ---

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-orange-500/30">
      <main className={cn(
        "p-6 mx-auto transition-all duration-500",
        videoUrl ? "max-w-[1600px] flex flex-col lg:flex-row gap-8 lg:items-stretch" : "max-w-6xl"
      )}>
        {!videoUrl ? (
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="mt-20 border-2 border-dashed border-zinc-800 rounded-3xl h-[400px] flex flex-col items-center justify-center gap-6 group hover:border-orange-500/50 transition-all bg-zinc-900/20"
          >
            <div className="w-20 h-20 bg-zinc-800 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
              <Upload className="w-10 h-10 text-zinc-500 group-hover:text-orange-500" />
            </div>
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">Drop your video here</h2>
              <p className="text-zinc-500">or paste from clipboard (Ctrl+V)</p>
            </div>
            <label className="cursor-pointer bg-zinc-100 text-black px-6 py-2.5 rounded-full font-bold hover:bg-white transition-all">
              Browse Files
              <input 
                type="file" 
                className="hidden" 
                accept="video/*" 
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} 
              />
            </label>
          </motion.div>
        ) : (
          <>
            {/* Left Column: Video & Timeline */}
            <div className="flex-1 flex flex-col gap-6 min-w-0">
              {/* Viewport */}
              <div 
                ref={containerRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onDoubleClick={resetCrop}
                className={cn(
                  "relative bg-[#1a1a1a] rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl group transition-all duration-300 mx-auto",
                  isPreviewMode ? "w-full" : "w-fit max-w-full max-h-[70vh]"
                )}
                style={{ 
                  cursor: isCropping ? 'crosshair' : 'default',
                  backgroundImage: 'radial-gradient(#2a2a2a 1px, transparent 1px)',
                  backgroundSize: '20px 20px',
                  aspectRatio: videoMetadata.width ? (
                    isPreviewMode 
                      ? `${cropArea.width * videoMetadata.width} / ${cropArea.height * videoMetadata.height}` 
                      : `${videoMetadata.width} / ${videoMetadata.height}`
                  ) : '16/9'
                }}
              >
				<video 
                  ref={videoRef}
                  src={videoUrl}
                  className={cn(
                    "w-full h-full transition-all duration-300 outline-none",
                    isPreviewMode ? "object-fill" : "object-contain"
                  )}
                  style={isPreviewMode ? {
                    width: `${(100 / cropArea.width) * 100}%`,
                    height: `${(100 / cropArea.height) * 100}%`,
                    maxWidth: 'none',
                    position: 'absolute',
                    left: `${-cropArea.x * (100 / cropArea.width)}%`,
                    top: `${-cropArea.y * (100 / cropArea.height)}%`,
                  } : {}}
                  onLoadedMetadata={handleMetadataLoaded}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => {
                    if (isLooping) {
                      const start = Math.min(trimRange.start, trimRange.end);
                      seekTo(start);
                      videoRef.current?.play();
                    } else {
                      setIsPlaying(false);
                    }
                  }}
                  onClick={() => !isCropping && togglePlay()}
                  tabIndex={0}
                />

                {/* Crop Overlay */}
                <div 
                  className={cn(
                    "absolute border-2 border-orange-500 transition-opacity",
                    (isCropping || dragStartPos.current || resizeHandle || cropArea.width < 100 || cropArea.height < 100) ? "opacity-100" : "opacity-0",
                    isPreviewMode && "hidden"
                  )}
                  style={{
                    left: `${cropArea.x}%`,
                    top: `${cropArea.y}%`,
                    width: `${cropArea.width}%`,
                    height: `${cropArea.height}%`,
                    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
                    pointerEvents: isCropping ? 'none' : 'auto'
                  }}
                >
                  <div className="absolute -top-6 left-0 bg-orange-500 text-black text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">
                    Crop Area
                  </div>
                  
                  {/* Resize Handles */}
                  {!isCropping && (
                    <>
                      <div data-handle="nw" className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-nw-resize z-50 pointer-events-auto" />
                      <div data-handle="n" className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-n-resize z-50 pointer-events-auto" />
                      <div data-handle="ne" className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-ne-resize z-50 pointer-events-auto" />
                      <div data-handle="e" className="absolute top-1/2 -translate-y-1/2 -right-1.5 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-e-resize z-50 pointer-events-auto" />
                      <div data-handle="se" className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-se-resize z-50 pointer-events-auto" />
                      <div data-handle="s" className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-s-resize z-50 pointer-events-auto" />
                      <div data-handle="sw" className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-sw-resize z-50 pointer-events-auto" />
                      <div data-handle="w" className="absolute top-1/2 -translate-y-1/2 -left-1.5 w-3 h-3 bg-white border border-orange-500 rounded-full cursor-w-resize z-50 pointer-events-auto" />
                    </>
                  )}

                  <button 
                    onClick={(e) => { e.stopPropagation(); resetCrop(); }}
                    className="absolute -top-6 right-0 bg-zinc-800 text-white p-1 rounded hover:bg-zinc-700 pointer-events-auto"
                    title="Reset Crop"
                  >
                    <RefreshCcw className="w-3 h-3" />
                  </button>
                </div>

                {/* Playback Controls Overlay */}
                <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  <button 
                    onClick={(e) => { e.stopPropagation(); togglePlay(); }}
                    className="w-16 h-16 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center pointer-events-auto hover:scale-110 transition-transform"
                  >
                    {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8 ml-1" />}
                  </button>
                </div>
              </div>

              {/* Timeline Section */}
              <div className="mt-auto bg-zinc-950 border border-zinc-800/60 p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between text-xs font-mono text-zinc-500">
                  <div className="flex items-center gap-3">
                    <span className="text-zinc-300">{formatTime(currentTime)}</span>
                    <span className="opacity-40">/</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-zinc-400">
                      Duration: {formatTime(Math.abs(trimRange.end - trimRange.start))}
                    </span>
                  </div>
                </div>

                {/* High-Performance Track */}
                <div 
                  ref={timelineRef}
                  onPointerDown={(e) => handleTimelinePointerDown(e, 'playhead')}
                  onPointerMove={handleTimelinePointerMove}
                  onPointerUp={handleTimelinePointerUp}
                  onPointerCancel={handleTimelinePointerUp}
                  onContextMenu={(e) => e.preventDefault()}
                  className="relative h-12 bg-[#111] border border-zinc-800/80 rounded-lg cursor-text select-none group touch-none overflow-hidden"
                >
                  {/* Unselected Out-of-bounds Areas (Dimmed) */}
                  <div 
                    className="absolute top-0 bottom-0 left-0 bg-black/60 z-0 backdrop-blur-[1px]"
                    style={{ width: `${duration > 0 ? (Math.min(trimRange.start, trimRange.end) / duration) * 100 : 0}%` }}
                  />
                  <div 
                    className="absolute top-0 bottom-0 right-0 bg-black/60 z-0 backdrop-blur-[1px]"
                    style={{ width: `${duration > 0 ? (100 - (Math.max(trimRange.start, trimRange.end) / duration) * 100) : 0}%` }}
                  />

                  {/* Active Selected Clip Range */}
                  <div 
                    className="absolute top-0 bottom-0 border-y border-zinc-700/50 bg-zinc-800/20 z-0 pointer-events-none"
                    style={{ 
                      left: `${duration > 0 ? (Math.min(trimRange.start, trimRange.end) / duration) * 100 : 0}%`,
                      right: `${duration > 0 ? (100 - (Math.max(trimRange.start, trimRange.end) / duration) * 100) : 0}%`
                    }}
                  />

                  {/* Start Marker Handle */}
                  <div 
                    className="absolute top-0 bottom-0 w-6 -translate-x-1/2 cursor-ew-resize z-20 flex items-center justify-center group/marker"
                    style={{ left: `${duration > 0 ? (trimRange.start / duration) * 100 : 0}%` }}
                    onPointerDown={(e) => handleTimelinePointerDown(e, 'start')}
                  >
                    <div className="w-1 h-3/5 bg-zinc-500 group-hover/marker:bg-white rounded-full transition-colors" />
                  </div>

                  {/* End Marker Handle */}
                  <div 
                    className="absolute top-0 bottom-0 w-6 -translate-x-1/2 cursor-ew-resize z-20 flex items-center justify-center group/marker"
                    style={{ left: `${duration > 0 ? (trimRange.end / duration) * 100 : 0}%` }}
                    onPointerDown={(e) => handleTimelinePointerDown(e, 'end')}
                  >
                    <div className="w-1 h-3/5 bg-zinc-500 group-hover/marker:bg-white rounded-full transition-colors" />
                  </div>

                  {/* Playhead Line */}
                  <div 
                    className="absolute top-0 bottom-0 w-px bg-orange-500 z-30 pointer-events-none shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                    style={{ left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                  >
                    {/* Tiny Triangle / Dot on top of playhead */}
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-orange-500 rounded-sm" />
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Sidebar Controls */}
            <aside className="w-full lg:w-80 flex flex-col gap-6">
              {/* Playback & History */}
              <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Playback</h3>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setIsLooping(!isLooping)}
                      className={cn(
                        "p-1.5 rounded-lg transition-all border",
                        isLooping 
                          ? "bg-orange-500/10 border-orange-500/50 text-orange-500" 
                          : "bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300"
                      )}
                      title="Loop playback"
                    >
                      <Repeat className={cn("w-4 h-4", isLooping && "animate-spin-slow")} />
                    </button>
                    <button 
                      onClick={undo}
                      disabled={history.length <= 1}
                      className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-30 transition-colors"
                      title="Undo (Ctrl+Z)"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={redo}
                      disabled={redoStack.length === 0}
                      className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-30 transition-colors"
                      title="Redo (Ctrl+Shift+Z)"
                    >
                      <Redo2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={togglePlay}
                    className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition-all"
                  >
                    {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                    {isPlaying ? "Pause" : "Play"}
                  </button>
                  <button 
                    onClick={() => {
                      setVideoFile(null);
                      setVideoUrl(null);
                    }}
                    className="px-4 rounded-xl bg-zinc-800 hover:bg-red-500/20 hover:text-red-400 text-zinc-400 transition-all border border-zinc-700 flex items-center justify-center"
                    title="Close Video"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Crop Controls */}
              <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-2xl space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Crop & Transform</h3>
                <div className="grid grid-cols-1 gap-3">
                  <button 
                    onClick={() => setIsCropping(!isCropping)}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all border",
                      isCropping 
                        ? "bg-orange-500 border-orange-400 text-black shadow-[0_0_20px_rgba(249,115,22,0.3)]" 
                        : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700"
                    )}
                  >
                    <Crop className="w-5 h-5" />
                    {isCropping ? "Finish Selection" : "Select Crop Area"}
                  </button>
                  <button 
                    onClick={detectBars}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 transition-all"
                  >
                    <Scan className="w-5 h-5 text-orange-500" />
                    Auto-Detect Bars
                  </button>
                  <button 
                    onClick={() => setIsPreviewMode(!isPreviewMode)}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all border",
                      isPreviewMode 
                        ? "bg-blue-500 border-blue-400 text-white" 
                        : "bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700"
                    )}
                  >
                    {isPreviewMode ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    {isPreviewMode ? "Exit Preview" : "Preview Result"}
                  </button>
                </div>
                
                <div className="pt-2">
                  <label className="text-[10px] uppercase tracking-widest text-zinc-600 font-bold block mb-2">Output Scaling (%)</label>
                  <div className="flex items-center gap-4">
                    <input 
                      type="range"
                      min="10"
                      max="100"
                      step="5"
                      value={outputScale}
                      onChange={(e) => setOutputScale(parseInt(e.target.value))}
                      className="flex-1 accent-orange-500 h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer"
                    />
                    <span className="text-xs font-mono text-orange-500/80 w-10 text-right">{outputScale}%</span>
                  </div>
                </div>

                <div className="pt-2">
                  <label className="text-[10px] uppercase tracking-widest text-zinc-600 font-bold block mb-2">Output Resolution</label>
                  <div className="bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-orange-500/80">
                    {Math.round((cropArea.width / 100) * videoMetadata.width * (outputScale / 100))} × {Math.round((cropArea.height / 100) * videoMetadata.height * (outputScale / 100))}
                  </div>
                </div>
              </div>

              {/* Trim Controls */}
              <div className="bg-zinc-900/50 border border-zinc-800 p-5 rounded-2xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Trim Settings</h3>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase">Start</label>
                      <input 
                        type="number" 
                        step="0.1"
                        value={trimRange.start.toFixed(2)}
                        onChange={(e) => setTrimRange(prev => ({ ...prev, start: Math.max(0, parseFloat(e.target.value)) }))}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-500 font-mono"
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase">End</label>
                      <input 
                        type="number" 
                        step="0.1"
                        value={trimRange.end.toFixed(2)}
                        onChange={(e) => setTrimRange(prev => ({ ...prev, end: Math.min(duration, parseFloat(e.target.value)) }))}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-500 font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={() => setTrimRange(prev => ({ ...prev, start: currentTime }))}
                      className="py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-bold uppercase tracking-wider text-zinc-400 border border-zinc-700"
                    >
                      Set Start (B)
                    </button>
                    <button 
                      onClick={() => setTrimRange(prev => ({ ...prev, end: currentTime }))}
                      className="py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-bold uppercase tracking-wider text-zinc-400 border border-zinc-700"
                    >
                      Set End (N)
                    </button>
                  </div>
                </div>
              </div>

              {/* Export Buttons */}
              <div className="mt-auto space-y-3">
                <button 
                  onClick={() => exportVideo()}
                  disabled={isProcessing}
                  className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl text-lg font-black bg-white text-black hover:bg-orange-500 hover:text-white transition-all shadow-xl disabled:opacity-50 group"
                >
                  <Download className="w-6 h-6 group-hover:bounce" />
                  {isProcessing ? `Exporting ${progress}%` : "Export Video"}
                </button>
              </div>
            </aside>
          </>
        )}
      </main>

      {/* Processing Overlay */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 backdrop-blur-xl z-[100] flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="w-24 h-24 mb-8 relative">
              <svg className="w-full h-full" viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="45" fill="none" stroke="#1f2937" strokeWidth="8" />
                <circle 
                  cx="50" cy="50" r="45" fill="none" stroke="#f97316" strokeWidth="8" 
                  strokeDasharray="282.7"
                  strokeDashoffset={282.7 - (282.7 * progress) / 100}
                  strokeLinecap="round"
                  className="transition-all duration-300"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center font-bold text-xl">
                {progress}%
              </div>
            </div>
            <h3 className="text-2xl font-bold mb-2">Processing Video</h3>
            <p className="text-zinc-500 max-w-md">
              We're applying your crops and trims using multi-threaded WASM. 
              Rendering speed is optimized with the 'ultrafast' preset.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Quick Tips */}
      {!videoUrl && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 flex gap-8 text-zinc-600">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest font-bold">
            <Clipboard className="w-4 h-4" />
            Paste Support
          </div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest font-bold">
            <FileVideo className="w-4 h-4" />
            MP4 / WebM / MOV
          </div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest font-bold">
            <Maximize className="w-4 h-4" />
            Auto-Crop
          </div>
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}