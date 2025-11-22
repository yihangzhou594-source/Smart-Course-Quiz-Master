import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Upload, FileText, CheckCircle, XCircle, Brain, RefreshCw, Play, ChevronRight, AlertCircle, Loader2, Image as ImageIcon, Trash2, FileType, Captions, ListChecks, ToggleLeft, Settings2, Hash, BookOpen, Sparkles, Lightbulb, Link as LinkIcon, Globe, FileCode, FileAudio, FileVideo, Info } from 'lucide-react';

// --- Globals ---
declare const JSZip: any;

// --- Types ---

type QuestionType = 'TRUE_FALSE' | 'MULTIPLE_CHOICE';

type Question = {
  id: number;
  type: QuestionType;
  text: string;
  options?: string[]; // Only for MCQ
  correctAnswer: boolean | string;
  explanation: string;
};

type SummaryConcept = {
  title: string;
  emoji: string;
  points: string[];
};

type QuizState = 'SETUP' | 'GENERATING' | 'KNOWLEDGE' | 'PLAYING' | 'SUMMARY';

type UserAnswer = {
  questionId: number;
  answer: boolean | string;
  isCorrect: boolean;
};

type QuizConfig = {
  type: QuestionType;
  count: number;
  enableSummary: boolean;
};

type MediaFile = {
  data: string; // Base64 data
  mimeType: string;
  type: 'image' | 'audio' | 'video';
  name: string;
};

// --- Constants ---

const MODEL_NAME = 'gemini-2.5-flash';
const MAX_FILE_SIZE_MB = 20; // Browser memory safety limit for Base64

// --- Components ---

const App = () => {
  const [quizState, setQuizState] = useState<QuizState>('SETUP');
  
  // Content State
  const [pptText, setPptText] = useState('');
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [urlInput, setUrlInput] = useState('');
  
  // Settings State
  const [config, setConfig] = useState<QuizConfig>({
    type: 'TRUE_FALSE',
    count: 15,
    enableSummary: true
  });

  // Quiz Data State
  const [quizSummary, setQuizSummary] = useState<SummaryConcept[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<UserAnswer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  // --- Gemini Logic ---

  const generateQuiz = async () => {
    if (!pptText.trim() && mediaFiles.length === 0) {
      setError("Please provide content (Text, Slides, Audio, or Video) to generate questions.");
      return;
    }

    setQuizState('GENERATING');
    setError(null);
    setQuizSummary([]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const parts: any[] = [];
      
      if (pptText) {
        parts.push({ text: `Here is the text content/speaker notes/scripts extracted from the files:\n\n${pptText}` });
      }
      
      for (const file of mediaFiles) {
        // Strip the data URL prefix (e.g., "data:image/png;base64,")
        const base64Data = file.data.split(',')[1]; 
        parts.push({
          inlineData: {
            data: base64Data,
            mimeType: file.mimeType
          }
        });
      }

      // Dynamic Prompt Construction
      let taskDescription = "";
      let questionSchema: Schema;

      if (config.type === 'TRUE_FALSE') {
        taskDescription = `
          Create exactly ${config.count} "True or False" judgment questions.
          - Focus on nuance, confusing concepts, and details in speaker notes or audio tracks.
          - Create questions that sound plausible but are false, or vice versa.
        `;
        questionSchema = {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, description: "The statement for the True/False question." },
              correctAnswer: { type: Type.BOOLEAN, description: "True if correct, False if incorrect." },
              explanation: { type: Type.STRING, description: "Detailed explanation." }
            },
            required: ["text", "correctAnswer", "explanation"]
        };
      } else {
        taskDescription = `
          Create exactly ${config.count} Multiple Choice Questions (MCQ).
          - Each question must have 4 distinct options.
          - Only ONE option should be correct.
          - Distractors should be plausible and challenging.
        `;
        questionSchema = {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, description: "The question text." },
              options: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "An array of exactly 4 possible answers."
              },
              correctAnswer: { type: Type.STRING, description: "The exact string text of the correct option." },
              explanation: { type: Type.STRING, description: "Detailed explanation." }
            },
            required: ["text", "options", "correctAnswer", "explanation"]
        };
      }

      let finalSchema: Schema;

      if (config.enableSummary) {
        finalSchema = {
          type: Type.OBJECT,
          properties: {
            keyConcepts: {
              type: Type.ARRAY,
              description: "A structured list of 6-10 key concepts extracted from the material.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "The name of the concept." },
                  emoji: { type: Type.STRING, description: "A single emoji representing this concept." },
                  points: { 
                    type: Type.ARRAY, 
                    items: { type: Type.STRING }, 
                    description: "3-5 brief bullet points explaining the concept." 
                  }
                },
                required: ["title", "emoji", "points"]
              }
            },
            questions: {
              type: Type.ARRAY,
              items: questionSchema
            }
          },
          required: ["keyConcepts", "questions"]
        };
      } else {
        finalSchema = {
          type: Type.ARRAY,
          items: questionSchema
        };
      }

      const prompt = `
        You are a strict university-level exam creator.
        
        TASK:
        Analyze the provided content. This may include text, slides (images), AUDIO recordings, or VIDEO clips.
        If audio/video is provided, listen/watch carefully to extract the educational content.
        
        ${config.enableSummary ? "First, extract the key knowledge points into a structured format (Concepts, Emoji, Bullet Points) to help students review." : ""}
        Then, ${taskDescription}
        
        CRITICAL GUIDELINES:
        1. **High Difficulty**: Challenging questions only.
        2. **Comprehensive**: Cover the provided material evenly.
        3. **Educational**: Explanations must reference the logic used.

        Output pure JSON matching the schema.
      `;

      parts.push({ text: prompt });

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          responseSchema: finalSchema
        }
      });

      const rawText = response.text || "{}";
      const generatedData = JSON.parse(rawText);
      
      let parsedQuestions: any[] = [];

      if (config.enableSummary) {
         if (!generatedData.questions || generatedData.questions.length === 0) {
             throw new Error("Questions were not generated properly.");
         }
         setQuizSummary(generatedData.keyConcepts || []);
         parsedQuestions = generatedData.questions;
      } else {
         if (!Array.isArray(generatedData) || generatedData.length === 0) {
             throw new Error("Questions were not generated properly.");
         }
         parsedQuestions = generatedData;
      }

      const formattedQuestions = parsedQuestions.map((q: any, index: number) => ({
        id: index,
        type: config.type,
        text: q.text,
        options: q.options, // undefined for T/F
        correctAnswer: q.correctAnswer,
        explanation: q.explanation
      }));

      setQuestions(formattedQuestions);
      
      if (config.enableSummary) {
        setQuizState('KNOWLEDGE');
      } else {
        setQuizState('PLAYING');
      }
      
      setCurrentQuestionIndex(0);
      setUserAnswers([]);

    } catch (e: any) {
      console.error(e);
      setError(e.message || "Failed to generate quiz. Please ensure your content is clear and try again.");
      setQuizState('SETUP');
    }
  };

  // --- Fetch URL Logic ---
  
  const handleUrlFetch = async () => {
    if (!urlInput) return;
    setIsProcessingFile(true);
    setError(null);
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: {
          parts: [{ text: `
            Visit this URL and extract the main text content, article body, or video transcript if available.
            
            URL: ${urlInput}
            
            Instructions:
            1. If the page is a video (YouTube, Vimeo, etc.), try to find and extract the transcript/captions.
            2. If the page is an article/blog, extract the main body text.
            3. If the content is likely behind a login (like Edstem, Canvas, Coursera) or inaccessible, DO NOT generate fake content. Instead, strictly reply with "ACCESS_DENIED".
            4. If successful, output the content clearly.
          ` }]
        },
        config: {
          tools: [{ googleSearch: {} }],
        }
      });

      const text = response.text || "";
      
      if (text.includes("ACCESS_DENIED")) {
        throw new Error("Cannot access this URL (it likely requires login). Please try uploading an Audio file, PDF, or VTT caption file instead.");
      }
      
      if (text.length < 50) {
         throw new Error("Could not extract meaningful content from this URL.");
      }

      setPptText(prev => prev + `\n\n--- EXTRACTED FROM URL: ${urlInput} ---\n${text}`);
      setUrlInput('');
    } catch (e: any) {
      setError(e.message || "Failed to fetch URL content.");
    } finally {
      setIsProcessingFile(false);
    }
  };

  // --- File Parsers ---
  
  const extractTextFromHtml = async (file: File): Promise<string> => {
    try {
      const text = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/html');
      
      // Remove non-content elements to reduce noise
      const scripts = doc.querySelectorAll('script, style, nav, footer, header, meta, noscript, svg, img, form');
      scripts.forEach(el => el.remove());
      
      // Get the text content
      let bodyText = doc.body.innerText || "";
      
      // Clean up excessive whitespace
      bodyText = bodyText.replace(/\n\s*\n/g, '\n').trim();
      
      return `--- CONTENT EXTRACTED FROM HTML FILE: ${file.name} ---\n${bodyText}`;
    } catch (e) {
      console.error("HTML Parse Error", e);
      throw new Error("Could not parse HTML file.");
    }
  };

  const extractTextFromPptx = async (file: File): Promise<string> => {
    try {
      const zip = await JSZip.loadAsync(file);
      const files = zip.files;
      let finalOutput = `--- CONTENT EXTRACTED FROM ${file.name} ---\n\n`;
      
      const slideRegex = /ppt\/slides\/slide(\d+)\.xml$/;
      const slideFiles = Object.keys(files).filter(name => slideRegex.test(name));
      
      slideFiles.sort((a, b) => {
        const matchA = a.match(slideRegex);
        const matchB = b.match(slideRegex);
        const numA = matchA ? parseInt(matchA[1]) : 0;
        const numB = matchB ? parseInt(matchB[1]) : 0;
        return numA - numB;
      });

      const parser = new DOMParser();

      for (const slideFilename of slideFiles) {
        const match = slideFilename.match(slideRegex);
        const slideNum = match ? match[1] : '?';
        const slideContent = await zip.file(slideFilename).async("string");
        const slideDoc = parser.parseFromString(slideContent, "text/xml");
        
        const paragraphs = Array.from(slideDoc.getElementsByTagName("p")); 
        let slideText = "";
        
        if (paragraphs.length === 0 && slideContent.includes("<a:t")) {
           const matches = slideContent.match(/<a:t[^>]*>(.*?)<\/a:t>/g);
           if (matches) {
             slideText = matches.map((m: string) => m.replace(/<\/?a:t[^>]*>/g, "")).join(" ");
           }
        } else {
          slideText = paragraphs.map(p => {
             const texts = Array.from(p.getElementsByTagName("t")); 
             return texts.map(t => t.textContent).join("");
          }).filter(t => t.trim().length > 0).join("\n");
        }

        finalOutput += `[SLIDE ${slideNum}]\n${slideText}\n`;

        const relsFilename = `ppt/slides/_rels/slide${slideNum}.xml.rels`;
        if (files[relsFilename]) {
           const relsContent = await files[relsFilename].async("string");
           const relMatch = relsContent.match(/Target="([^"]*)"[^>]*Type="[^"]*notesSlide"/);
           const relMatchReverse = relsContent.match(/Type="[^"]*notesSlide"[^>]*Target="([^"]*)"/);
           let noteTarget = (relMatch && relMatch[1]) || (relMatchReverse && relMatchReverse[1]);
           
           if (noteTarget) {
             const noteFilenamePart = noteTarget.split('/').pop(); 
             const noteFullPath = `ppt/notesSlides/${noteFilenamePart}`;
             if (files[noteFullPath]) {
               const noteContent = await files[noteFullPath].async("string");
               const matches = noteContent.match(/<a:t[^>]*>(.*?)<\/a:t>/g);
               if (matches) {
                 const noteText = matches.map((m: string) => m.replace(/<\/?a:t[^>]*>/g, "")).join(" ");
                 finalOutput += `[SPEAKER NOTES]\n${noteText}\n`;
               }
             }
           }
        }
        finalOutput += `\n`;
      }
      return finalOutput;
    } catch (e) {
      console.error("PPTX Parse Error", e);
      throw new Error("Could not parse PPTX file. Is it a valid PowerPoint .pptx file?");
    }
  };

  const parseVTT = (content: string): string => {
    const lines = content.split(/\r?\n/);
    let extractedText = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('WEBVTT') || trimmed.startsWith('NOTE') || trimmed.includes('-->')) continue;
      if (/^\d+$/.test(trimmed)) continue;
      extractedText += trimmed.replace(/<[^>]*>/g, "") + " ";
    }
    return extractedText.trim();
  };

  // --- Handlers ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setIsProcessingFile(true);
      setError(null);
      try {
        const files = Array.from(e.target.files);
        
        // Filter files by type
        const imageFiles = files.filter(f => f.type.startsWith('image/'));
        const audioFiles = files.filter(f => f.type.startsWith('audio/'));
        const videoFiles = files.filter(f => f.type.startsWith('video/'));
        const pptxFiles = files.filter(f => f.name.endsWith('.pptx') || f.type.includes('presentation') || f.type.includes('powerpoint'));
        const vttFiles = files.filter(f => f.name.endsWith('.vtt') || f.type === 'text/vtt');
        const htmlFiles = files.filter(f => f.name.endsWith('.html') || f.name.endsWith('.htm') || f.type === 'text/html');

        // Process Images
        if (imageFiles.length > 0) {
          const readers = imageFiles.map(file => new Promise<MediaFile>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve({
                data: reader.result as string,
                mimeType: file.type,
                type: 'image',
                name: file.name
            });
            reader.readAsDataURL(file);
          }));
          const results = await Promise.all(readers);
          setMediaFiles(prev => [...prev, ...results]);
        }
        
        // Process Audio/Video
        const avFiles = [...audioFiles, ...videoFiles];
        if (avFiles.length > 0) {
             const readers = avFiles.map(file => new Promise<MediaFile>((resolve, reject) => {
                if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                    reject(new Error(`File ${file.name} is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max ${MAX_FILE_SIZE_MB}MB allowed.`));
                    return;
                }
                const reader = new FileReader();
                reader.onloadend = () => resolve({
                    data: reader.result as string,
                    mimeType: file.type,
                    type: file.type.startsWith('audio') ? 'audio' : 'video',
                    name: file.name
                });
                reader.readAsDataURL(file);
            }));
            try {
                const results = await Promise.all(readers);
                setMediaFiles(prev => [...prev, ...results]);
            } catch (avError: any) {
                setError(avError.message); // Show size error
            }
        }

        // Process Text-based files
        let newText = "";
        if (pptxFiles.length > 0) {
          for (const pptFile of pptxFiles) {
             const text = await extractTextFromPptx(pptFile);
             newText += text + "\n\n";
          }
        }
        if (vttFiles.length > 0) {
          for (const vttFile of vttFiles) {
            const rawContent = await vttFile.text();
            newText += `--- SCRIPT FROM ${vttFile.name} ---\n${parseVTT(rawContent)}\n\n`;
          }
        }
        if (htmlFiles.length > 0) {
          for (const htmlFile of htmlFiles) {
             const text = await extractTextFromHtml(htmlFile);
             newText += text + "\n\n";
          }
        }

        if (newText) {
          setPptText(prev => (prev ? prev + "\n\n" + newText : newText));
        }
      } catch (err: any) {
        setError(err.message || "Failed to process files.");
      } finally {
        setIsProcessingFile(false);
        e.target.value = '';
      }
    }
  };

  const removeMedia = (idx: number) => {
    setMediaFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const handleAnswer = (answer: boolean | string) => {
    const currentQ = questions[currentQuestionIndex];
    const isCorrect = answer === currentQ.correctAnswer;
    
    const newRecord: UserAnswer = {
      questionId: currentQ.id,
      answer: answer,
      isCorrect
    };
    
    const newAnswers = [...userAnswers];
    newAnswers[currentQuestionIndex] = newRecord;
    setUserAnswers(newAnswers);
  };

  return (
    <div className="min-h-screen flex flex-col items-center py-8 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto">
      <header className="mb-8 text-center w-full">
        <h1 className="text-3xl md:text-4xl font-extrabold text-gray-900 flex items-center justify-center gap-3 mb-2">
          <Brain className="w-10 h-10 text-indigo-600" />
          <span>Smart Course Quiz Master</span>
        </h1>
        <p className="text-gray-600 max-w-2xl mx-auto">
          Import course materials (Slides, Videos, Audio, or Transcripts). AI will "watch" and "read" everything to generate university-level questions.
        </p>
      </header>

      <main className="w-full bg-white shadow-xl rounded-2xl overflow-hidden min-h-[500px] flex flex-col">
        {quizState === 'SETUP' && (
          <SetupView 
            pptText={pptText} 
            setPptText={setPptText} 
            mediaFiles={mediaFiles} 
            removeMedia={removeMedia}
            handleFileUpload={handleFileUpload}
            onGenerate={generateQuiz}
            error={error}
            isProcessingFile={isProcessingFile}
            config={config}
            setConfig={setConfig}
            urlInput={urlInput}
            setUrlInput={setUrlInput}
            onFetchUrl={handleUrlFetch}
          />
        )}
        
        {quizState === 'GENERATING' && (
          <div className="flex flex-col items-center justify-center flex-grow p-12 space-y-6">
            <div className="relative">
              <div className="absolute inset-0 bg-indigo-200 rounded-full animate-ping opacity-25"></div>
              <Loader2 className="w-16 h-16 text-indigo-600 animate-spin relative z-10" />
            </div>
            <div className="text-center space-y-2">
              <h3 className="text-2xl font-semibold text-gray-800">Analyzing Content...</h3>
              <p className="text-gray-500 max-w-md">
                {mediaFiles.some(f => f.type === 'audio' || f.type === 'video') ? "Listening to audio tracks and processing video frames..." : "Reading documents..."}
              </p>
              <p className="text-xs text-gray-400">This might take up to 30 seconds for large media files.</p>
            </div>
          </div>
        )}

        {quizState === 'KNOWLEDGE' && (
          <KnowledgeView 
            concepts={quizSummary}
            onStartQuiz={() => setQuizState('PLAYING')}
          />
        )}

        {quizState === 'PLAYING' && questions.length > 0 && (
          <QuizView 
            question={questions[currentQuestionIndex]} 
            currentQuestionIndex={currentQuestionIndex}
            totalQuestions={questions.length}
            onAnswer={handleAnswer}
            onNext={() => currentQuestionIndex < questions.length - 1 ? setCurrentQuestionIndex(p => p + 1) : setQuizState('SUMMARY')}
          />
        )}

        {quizState === 'SUMMARY' && (
          <SummaryView 
            questions={questions} 
            userAnswers={userAnswers} 
            onRestart={() => {
               setQuizState('SETUP');
               setPptText('');
               setMediaFiles([]);
               setQuestions([]);
               setQuizSummary([]);
               setCurrentQuestionIndex(0);
               setUserAnswers([]);
               setError(null);
               setUrlInput('');
            }} 
            onReplay={() => {
               setQuizState('PLAYING');
               setCurrentQuestionIndex(0);
               setUserAnswers([]);
            }}
          />
        )}
      </main>
    </div>
  );
};

// --- Sub-Components ---

const SetupView = ({ pptText, setPptText, mediaFiles, removeMedia, handleFileUpload, onGenerate, error, isProcessingFile, config, setConfig, urlInput, setUrlInput, onFetchUrl }: any) => (
  <div className="p-6 md:p-8 space-y-6 slide-in flex-grow flex flex-col">
    
    {/* Configuration Bar */}
    <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-5 flex flex-col lg:flex-row gap-6 lg:items-center justify-between">
      <div className="flex items-center gap-3 text-indigo-800 font-bold uppercase tracking-wide text-sm border-b lg:border-b-0 lg:border-r border-indigo-200 pb-3 lg:pb-0 lg:pr-6 lg:w-auto w-full">
        <Settings2 className="w-5 h-5" />
        Settings
      </div>

      <div className="flex flex-col md:flex-row gap-6 flex-grow">
        {/* Question Type Selector */}
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-semibold text-indigo-900 mb-2 flex items-center gap-2">
             {config.type === 'TRUE_FALSE' ? <ToggleLeft className="w-4 h-4" /> : <ListChecks className="w-4 h-4" />}
             Question Type
          </label>
          <div className="flex bg-white rounded-lg p-1 border border-indigo-200 shadow-sm">
            <button
              onClick={() => setConfig({ ...config, type: 'TRUE_FALSE' })}
              className={`flex-1 py-2 text-xs sm:text-sm font-bold rounded-md transition-all ${config.type === 'TRUE_FALSE' ? 'bg-indigo-600 text-white shadow' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              True / False
            </button>
            <button
              onClick={() => setConfig({ ...config, type: 'MULTIPLE_CHOICE' })}
              className={`flex-1 py-2 text-xs sm:text-sm font-bold rounded-md transition-all ${config.type === 'MULTIPLE_CHOICE' ? 'bg-indigo-600 text-white shadow' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              Multiple Choice
            </button>
          </div>
        </div>

        {/* Count Slider */}
        <div className="flex-1 min-w-[150px]">
           <label className="block text-xs font-semibold text-indigo-900 mb-2 flex items-center gap-2">
             <Hash className="w-4 h-4" />
             Question Count: <span className="text-indigo-600 text-lg">{config.count}</span>
           </label>
           <input 
             type="range" 
             min="10" 
             max="50" 
             step="1"
             value={config.count}
             onChange={(e) => setConfig({ ...config, count: parseInt(e.target.value) })}
             className="w-full h-2 bg-indigo-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
           />
        </div>

        {/* Summary Toggle */}
        <div className="flex-1 flex items-center">
          <button 
             onClick={() => setConfig({ ...config, enableSummary: !config.enableSummary })}
             className={`flex items-center justify-between w-full p-3 rounded-lg border transition-all ${config.enableSummary ? 'bg-white border-indigo-300 shadow-sm' : 'bg-gray-100 border-transparent opacity-75'}`}
          >
            <div className="flex items-center gap-2">
               <BookOpen className={`w-4 h-4 ${config.enableSummary ? 'text-indigo-600' : 'text-gray-500'}`} />
               <div className="text-left">
                 <div className={`text-xs font-bold ${config.enableSummary ? 'text-indigo-900' : 'text-gray-600'}`}>Summary</div>
                 <div className="text-[10px] text-gray-500">Show key concepts</div>
               </div>
            </div>
            <div className={`w-8 h-4 flex items-center rounded-full p-0.5 duration-300 ease-in-out ${config.enableSummary ? 'bg-indigo-600' : 'bg-gray-300'}`}>
              <div className={`bg-white w-3 h-3 rounded-full shadow-md transform duration-300 ease-in-out ${config.enableSummary ? 'translate-x-4' : ''}`}></div>
            </div>
          </button>
        </div>
      </div>
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 flex-grow">
      {/* Text Input Column */}
      <div className="flex flex-col space-y-4">
        <label className="flex items-center gap-2 text-lg font-semibold text-gray-700">
          <FileText className="w-5 h-5 text-indigo-600" />
          Import Content
        </label>
        
        {/* URL Fetcher */}
        <div className="bg-gray-50 p-1 rounded-xl border border-gray-200 flex items-center gap-2 shadow-inner focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-indigo-500 transition-all">
          <div className="pl-3 text-gray-400">
            <LinkIcon className="w-4 h-4" />
          </div>
          <input 
            type="text" 
            placeholder="Paste public URL"
            className="flex-grow bg-transparent p-2 text-sm outline-none text-gray-700"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onFetchUrl()}
          />
          <button 
             onClick={onFetchUrl}
             disabled={!urlInput || isProcessingFile}
             className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-lg text-sm font-bold transition-colors flex items-center gap-2 m-1"
          >
             {isProcessingFile && urlInput ? <Loader2 className="w-3 h-3 animate-spin" /> : <Globe className="w-3 h-3" />}
             Fetch
          </button>
        </div>

        {/* Help Box for Private Sites */}
        <div className="bg-amber-50 text-amber-800 text-xs p-4 rounded-lg border border-amber-100 flex flex-col gap-2">
           <div className="flex items-center gap-2 font-bold text-amber-900">
             <Info className="w-4 h-4" />
             For Login-Protected Sites (Edstem, Canvas, etc):
           </div>
           <ul className="list-disc list-inside space-y-1 pl-1">
             <li><strong>Option 1 (Best for Video):</strong> Download the video/audio file and upload it here directly. AI will listen to it.</li>
             <li><strong>Option 2 (For Captions):</strong> Open DevTools (F12) &rarr; Network &rarr; Search "vtt" &rarr; Download the caption file.</li>
             <li><strong>Option 3 (For Text):</strong> Use "Print to PDF" or "Save as HTML" on the course page.</li>
           </ul>
        </div>

        <textarea
          className="flex-grow w-full p-4 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-none transition-all bg-gray-50 text-sm leading-relaxed shadow-inner min-h-[200px]"
          placeholder="Or paste your notes/transcript here..."
          value={pptText}
          onChange={(e) => setPptText(e.target.value)}
        ></textarea>
      </div>

      {/* Image/File Upload Column */}
      <div className="flex flex-col space-y-3">
        <label className="flex items-center gap-2 text-lg font-semibold text-gray-700">
          <Upload className="w-5 h-5 text-indigo-600" />
          Upload Media & Files
        </label>
        
        <div className="flex-grow flex flex-col">
           <div className={`border-2 border-dashed rounded-xl flex flex-col items-center justify-center bg-gray-50 hover:bg-indigo-50 transition-colors relative group cursor-pointer min-h-[150px] ${mediaFiles.length > 0 ? 'h-[150px]' : 'flex-grow' } ${isProcessingFile ? 'opacity-50 cursor-wait' : 'border-gray-300 hover:border-indigo-300'}`}>
              <input 
                type="file" 
                multiple 
                accept="image/*,audio/*,video/*,.pptx,.vtt,.html,.htm" 
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                onChange={handleFileUpload}
                disabled={isProcessingFile}
              />
              {isProcessingFile ? (
                <div className="flex flex-col items-center">
                  <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mb-2" />
                  <span className="text-gray-600 font-medium">Processing...</span>
                </div>
              ) : (
                <div className="text-center p-4">
                  <div className="flex justify-center gap-3 mb-3">
                     <div className="p-2 bg-white rounded-lg shadow-sm"><ImageIcon className="w-5 h-5 text-indigo-500" /></div>
                     <div className="p-2 bg-white rounded-lg shadow-sm"><FileAudio className="w-5 h-5 text-pink-500" /></div>
                     <div className="p-2 bg-white rounded-lg shadow-sm"><FileVideo className="w-5 h-5 text-purple-500" /></div>
                     <div className="p-2 bg-white rounded-lg shadow-sm"><FileType className="w-5 h-5 text-orange-500" /></div>
                  </div>
                  <p className="text-gray-600 font-medium">
                    Drop <span className="text-indigo-600">Video</span>, <span className="text-pink-600">Audio</span>, <span className="text-orange-600">PPTX</span>, or <span className="text-emerald-600">HTML/VTT</span>
                  </p>
                  <p className="text-xs text-gray-400 mt-2">Max 20MB per media file (browser limit)</p>
                </div>
              )}
           </div>

           {mediaFiles.length > 0 && (
             <div className="mt-4 flex-grow border border-gray-200 rounded-xl p-4 bg-gray-50 overflow-y-auto custom-scrollbar max-h-[280px]">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {mediaFiles.map((file: MediaFile, idx: number) => (
                      <div key={idx} className="relative group bg-white rounded-lg overflow-hidden border border-gray-300 shadow-sm">
                        {file.type === 'image' ? (
                           <div className="aspect-video">
                             <img src={file.data} alt={`File ${idx}`} className="w-full h-full object-cover" />
                           </div>
                        ) : file.type === 'audio' ? (
                           <div className="aspect-video flex flex-col items-center justify-center p-2 bg-pink-50">
                              <FileAudio className="w-8 h-8 text-pink-500 mb-1" />
                              <span className="text-[10px] text-gray-600 truncate w-full text-center">{file.name}</span>
                              <audio src={file.data} controls className="w-full h-6 mt-2 scale-75 origin-center" />
                           </div>
                        ) : (
                           <div className="aspect-video flex flex-col items-center justify-center bg-purple-50">
                              <video src={file.data} className="w-full h-full object-cover" />
                              <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-transparent transition-all pointer-events-none">
                                <Play className="w-8 h-8 text-white opacity-80" />
                              </div>
                           </div>
                        )}
                        <button 
                          onClick={() => removeMedia(idx)}
                          className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-sm"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                </div>
             </div>
           )}
        </div>
      </div>
    </div>

    {error && (
      <div className="bg-red-50 border border-red-100 text-red-700 px-4 py-3 rounded-lg flex items-center gap-3 animate-pulse">
        <AlertCircle className="w-5 h-5" />
        {error}
      </div>
    )}

    <div className="pt-4 border-t border-gray-100 flex justify-end">
      <button
        onClick={onGenerate}
        disabled={(!pptText && mediaFiles.length === 0) || isProcessingFile}
        className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white px-8 py-4 rounded-xl font-bold shadow-lg shadow-indigo-200 transform transition hover:-translate-y-1 active:translate-y-0"
      >
        {isProcessingFile ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
        Generate Quiz
      </button>
    </div>
  </div>
);

const KnowledgeView = ({ concepts, onStartQuiz }: { concepts: SummaryConcept[], onStartQuiz: () => void }) => {
  return (
    <div className="p-8 md:p-12 h-full flex flex-col fade-in max-w-6xl mx-auto w-full">
       <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6 pb-4 border-b border-indigo-100 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-100 p-3 rounded-full">
              <Sparkles className="w-6 h-6 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Knowledge Summary</h2>
              <p className="text-gray-500 text-sm">Review these key points before starting your quiz.</p>
            </div>
          </div>
          <button
            onClick={onStartQuiz}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-indigo-200 transform transition hover:-translate-y-1 active:translate-y-0 whitespace-nowrap"
          >
            Start Quiz <ChevronRight className="w-5 h-5" />
          </button>
       </div>
       
       <div className="flex-grow overflow-y-auto custom-scrollbar pr-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-6">
             {concepts.map((concept, idx) => (
               <div key={idx} className="bg-white border border-gray-100 rounded-xl p-6 shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col">
                 <div className="flex items-start gap-4 mb-4">
                    <span className="text-4xl bg-gray-50 p-2 rounded-lg">{concept.emoji}</span>
                    <div>
                      <h3 className="font-bold text-lg text-gray-900">{concept.title}</h3>
                      <div className="h-1 w-12 bg-indigo-500 rounded-full mt-2"></div>
                    </div>
                 </div>
                 <ul className="space-y-2">
                    {concept.points.map((point, pIdx) => (
                      <li key={pIdx} className="flex items-start gap-2 text-gray-600 text-sm leading-relaxed">
                        <div className="min-w-[6px] h-[6px] rounded-full bg-indigo-300 mt-1.5"></div>
                        {point}
                      </li>
                    ))}
                 </ul>
               </div>
             ))}
          </div>
       </div>
    </div>
  );
};

const QuizView = ({ question, currentQuestionIndex, totalQuestions, onAnswer, onNext }: any) => {
  const [hasAnswered, setHasAnswered] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<boolean | string | null>(null);

  useEffect(() => {
    setHasAnswered(false);
    setSelectedAnswer(null);
  }, [question.id]);

  const handleChoice = (choice: boolean | string) => {
    if (hasAnswered) return;
    setSelectedAnswer(choice);
    setHasAnswered(true);
    onAnswer(choice);
  };

  const isCorrect = selectedAnswer === question.correctAnswer;
  const isMCQ = question.type === 'MULTIPLE_CHOICE';

  return (
    <div className="p-6 md:p-10 h-full flex flex-col justify-between fade-in max-w-3xl mx-auto w-full">
      <div className="mb-6">
        <div className="flex justify-between items-end mb-2">
          <span className="text-sm font-bold text-indigo-600 tracking-wider uppercase">
            Question {currentQuestionIndex + 1} <span className="text-gray-400 font-normal">/ {totalQuestions}</span>
          </span>
          <span className="text-xs font-semibold bg-indigo-100 text-indigo-700 px-2 py-1 rounded uppercase">
            {isMCQ ? 'Multiple Choice' : 'Judgment'}
          </span>
        </div>
        <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
          <div 
            className="h-full bg-indigo-600 transition-all duration-500 ease-out" 
            style={{ width: `${((currentQuestionIndex + 1) / totalQuestions) * 100}%` }}
          ></div>
        </div>
      </div>

      <div className="flex-grow flex flex-col items-center justify-center mb-8">
        <h3 className="text-xl md:text-2xl font-bold text-center text-gray-800 leading-snug">
          {question.text}
        </h3>
      </div>

      <div className="space-y-6 w-full">
        {!hasAnswered ? (
          isMCQ ? (
            <div className="grid grid-cols-1 gap-3">
              {question.options.map((option: string, idx: number) => (
                <button
                  key={idx}
                  onClick={() => handleChoice(option)}
                  className="w-full text-left p-4 rounded-xl border-2 border-gray-200 bg-white hover:border-indigo-500 hover:bg-indigo-50 transition-all font-medium text-gray-700"
                >
                  <span className="font-bold text-indigo-500 mr-3">{String.fromCharCode(65 + idx)}.</span> {option}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-6">
              <button
                onClick={() => handleChoice(true)}
                className="group h-32 flex flex-col items-center justify-center rounded-2xl border-2 border-gray-200 bg-white hover:border-green-500 hover:bg-green-50 transition-all"
              >
                <CheckCircle className="w-8 h-8 text-gray-400 group-hover:text-green-600 mb-2" />
                <span className="text-lg font-bold text-gray-600 group-hover:text-green-700">TRUE</span>
              </button>
              <button
                onClick={() => handleChoice(false)}
                className="group h-32 flex flex-col items-center justify-center rounded-2xl border-2 border-gray-200 bg-white hover:border-red-500 hover:bg-red-50 transition-all"
              >
                <XCircle className="w-8 h-8 text-gray-400 group-hover:text-red-600 mb-2" />
                <span className="text-lg font-bold text-gray-600 group-hover:text-red-700">FALSE</span>
              </button>
            </div>
          )
        ) : (
          <div className={`rounded-2xl p-6 ${isCorrect ? 'bg-green-50 border-2 border-green-100' : 'bg-red-50 border-2 border-red-100'} slide-in shadow-sm`}>
            <div className="flex items-start gap-4 mb-4">
              <div className={`p-2 rounded-full ${isCorrect ? 'bg-green-200' : 'bg-red-200'} flex-shrink-0`}>
                {isCorrect ? <CheckCircle className="w-6 h-6 text-green-700" /> : <XCircle className="w-6 h-6 text-red-700" />}
              </div>
              <div>
                <h4 className={`text-xl font-bold ${isCorrect ? 'text-green-800' : 'text-red-800'}`}>
                  {isCorrect ? 'Correct!' : 'Incorrect'}
                </h4>
                <p className="text-gray-800 font-medium mt-1">
                  The answer is <span className="font-bold">{question.correctAnswer.toString()}</span>.
                </p>
              </div>
            </div>
            <div className="bg-white bg-opacity-60 rounded-lg p-4 text-gray-700 leading-relaxed border border-black/5">
              <span className="font-semibold text-gray-900 block mb-1 flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-amber-500" /> Explanation:
              </span>
              {question.explanation}
            </div>
            <div className="mt-6 flex justify-end">
              <button
                onClick={onNext}
                className="flex items-center gap-2 bg-gray-900 text-white px-8 py-3 rounded-lg font-semibold hover:bg-gray-800 transition-all shadow-lg hover:shadow-xl transform active:scale-95"
              >
                {currentQuestionIndex === totalQuestions - 1 ? 'See Results' : 'Next Question'}
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SummaryView = ({ questions, userAnswers, onRestart, onReplay }: any) => {
  const score = userAnswers.filter((a: UserAnswer) => a.isCorrect).length;
  const percentage = Math.round((score / questions.length) * 100);
  
  let gradeColor = "text-red-600";
  if (percentage >= 90) gradeColor = "text-green-600";
  else if (percentage >= 70) gradeColor = "text-indigo-600";
  else if (percentage >= 50) gradeColor = "text-yellow-600";

  return (
    <div className="p-8 fade-in h-full flex flex-col">
      <div className="text-center mb-8 flex-shrink-0">
        <h2 className={`text-3xl font-bold mb-2 ${gradeColor}`}>{percentage >= 70 ? "Great Job!" : "Keep Practicing"}</h2>
        <div className="text-7xl font-extrabold text-gray-900 mb-2 tracking-tight">{percentage}%</div>
        <p className="text-gray-500 font-medium">Score: {score} / {questions.length}</p>
      </div>

      <div className="flex-grow overflow-y-auto custom-scrollbar pr-2 mb-8 border-t border-b border-gray-100 py-4">
        <div className="space-y-4">
          {questions.map((q: Question, idx: number) => {
            const ua = userAnswers[idx];
            const isCorrect = ua?.isCorrect || false;
            const userText = ua ? ua.answer.toString() : 'SKIPPED';
            const correctText = q.correctAnswer.toString();

            return (
              <div key={q.id} className={`p-5 rounded-xl border-l-4 ${isCorrect ? 'border-l-green-500 bg-green-50/50' : 'border-l-red-500 bg-red-50/50'} border border-gray-100`}>
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <p className="font-semibold text-gray-900 text-lg mb-2">{q.text}</p>
                    <div className="flex flex-wrap gap-3 text-sm mb-3">
                      <span className={`px-2 py-1 rounded font-bold ${isCorrect ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        You: {userText}
                      </span>
                      {!isCorrect && (
                        <span className="px-2 py-1 rounded bg-gray-100 text-gray-700 font-bold">
                          Correct: {correctText}
                        </span>
                      )}
                    </div>
                    {!isCorrect && (
                      <div className="text-sm text-gray-700 bg-white p-3 rounded border border-gray-200">
                        <span className="font-bold text-indigo-600">Explanation:</span> {q.explanation}
                      </div>
                    )}
                  </div>
                  <div className="mt-1">
                    {isCorrect ? <CheckCircle className="w-6 h-6 text-green-500" /> : <XCircle className="w-6 h-6 text-red-500" />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex justify-center gap-4 flex-shrink-0">
         <button onClick={onReplay} className="flex items-center gap-2 bg-white text-indigo-600 border-2 border-indigo-600 px-6 py-3 rounded-xl font-bold hover:bg-indigo-50 transition-colors">
          <RefreshCw className="w-5 h-5" /> Retry Same
        </button>
        <button onClick={onRestart} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-bold shadow-lg transition-colors">
          <Upload className="w-5 h-5" /> New Content
        </button>
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);