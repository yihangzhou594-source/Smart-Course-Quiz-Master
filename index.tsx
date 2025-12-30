import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";
import { Upload, FileText, CircleCheck, CircleX, Brain, RefreshCw, Play, ChevronRight, AlertCircle, Loader2, ListChecks, ToggleLeft, Shuffle, BookOpen, Sparkles, Info, ArrowUp, ArrowDown, Eye, ArrowLeft, Check, X, Download, Activity, Mic, Eraser, GripVertical, CircleHelp, Filter, Target, History, Clock } from 'lucide-react';

// --- Globals ---
declare const JSZip: any;
declare const pdfjsLib: any;
const SRS_STORAGE_KEY = 'gemini_quiz_srs_data_v1';

// --- Types ---

type QuestionType = 'TRUE_FALSE' | 'MULTIPLE_CHOICE' | 'RANKING' | 'MIXED';

type Question = {
  id: number;
  type: QuestionType;
  text: string;
  options?: string[]; // MCQ options OR Ranking items (scrambled)
  correctAnswer: boolean | string | string[]; // Boolean for T/F, String for MCQ, String[] for Ranking (correct order)
  explanation: string;
};

type SRSItem = {
  id: string; // Hash of the question text
  question: Question;
  nextReview: number; // Timestamp
  interval: number; // Current interval in days
  repetition: number; // Number of successful recalls
};

type SummaryConcept = {
  title: string;
  emoji: string;
  points: string[];
};

type QuizState = 'SETUP' | 'TOPIC_SELECTION' | 'GENERATING' | 'KNOWLEDGE' | 'PLAYING' | 'SUMMARY' | 'REVIEW';

type UserAnswer = {
  questionId: number;
  answer: boolean | string | string[];
  isCorrect: boolean;
};

type QuizConfig = {
  type: QuestionType;
  count: number;
  enableSummary: boolean;
  enableTopicFilter: boolean;
};

type UsageStats = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

// --- Constants ---

// Switched to gemini-2.5-flash-preview as requested by the user
const MODEL_NAME = 'gemini-2.5-flash-preview';

// --- Helper Functions ---

/**
 * Robust retry mechanism specifically designed to handle:
 * - 503 / Model Overload
 * - RPC / XHR failures
 * - Temporary Quota issues
 */
const callGeminiWithRetry = async (ai: GoogleGenAI, params: any, retries = 6) => {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await ai.models.generateContent(params);
        } catch (error: any) {
            lastError = error;
            
            // Extract meaningful error strings
            const message = (error.message || JSON.stringify(error)).toLowerCase();
            const status = String(error.status || '').toUpperCase();

            // Check if it's an overload or transient server error
            const isOverloaded = 
                message.includes('overloaded') || 
                message.includes('capacity') || 
                message.includes('503') ||
                status === 'UNAVAILABLE';

            const isTransient = 
                isOverloaded ||
                message.includes('rpc failed') ||
                message.includes('xhr error') ||
                message.includes('500') ||
                message.includes('internal server error') ||
                status === 'INTERNAL' ||
                status === 'UNKNOWN';

            if (isTransient && i < retries - 1) {
                // Exponential backoff: 2s, 4s, 8s, 16s...
                // If overloaded, start with a longer delay
                const baseDelay = isOverloaded ? 3000 : 1500;
                const delay = Math.pow(2, i) * baseDelay + (Math.random() * 1000);
                
                console.warn(`Gemini API transient failure (Attempt ${i + 1}/${retries}). ${isOverloaded ? 'Model Overloaded.' : ''} Retrying in ${Math.round(delay)}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
};

const cleanVTT = (text: string): string => {
  let clean = text.replace(/WEBVTT\s?(\w*)\n/g, '');
  clean = clean.replace(/(\d{2}:)?\d{2}:\d{2}\.\d{3} --> (\d{2}:)?\d{2}:\d{2}\.\d{3}.*\n/g, '');
  clean = clean.replace(/<[^>]*>/g, '');
  return clean.split('\n').map(l => l.trim()).filter(l => l).join('\n');
};

const extractTextFromPPTX = async (file: File): Promise<string> => {
    try {
        const zip = await JSZip.loadAsync(file);
        const slideFiles = Object.keys(zip.files).filter(name => name.match(/ppt\/slides\/slide\d+\.xml/));
        const sortFn = (a: string, b: string) => {
            const numA = parseInt(a.match(/(\d+)\.xml/)![1]);
            const numB = parseInt(b.match(/(\d+)\.xml/)![1]);
            return numA - numB;
        };
        slideFiles.sort(sortFn);
        let fullText = `[File: ${file.name}]\n`;
        const parser = new DOMParser();
        for (const filename of slideFiles) {
            const content = await zip.file(filename).async("string");
            const xmlDoc = parser.parseFromString(content, "text/xml");
            const textNodes = xmlDoc.getElementsByTagName("a:t");
            let slideText = "";
            for (let i = 0; i < textNodes.length; i++) {
                slideText += textNodes[i].textContent + " ";
            }
            if (slideText.trim()) {
                const slideNum = filename.match(/slide(\d+)\.xml/)?.[1] || "?";
                fullText += `[Slide ${slideNum}]: ${slideText.trim()}\n`;
            }
        }
        const noteFiles = Object.keys(zip.files).filter(name => name.match(/ppt\/notesSlides\/notesSlide\d+\.xml/));
        if (noteFiles.length > 0) {
            fullText += `\n=== SPEAKER NOTES / FOOTNOTES ===\n`;
            noteFiles.sort(sortFn);
            for (const filename of noteFiles) {
                const content = await zip.file(filename).async("string");
                const xmlDoc = parser.parseFromString(content, "text/xml");
                const textNodes = xmlDoc.getElementsByTagName("a:t");
                let noteText = "";
                for (let i = 0; i < textNodes.length; i++) {
                    noteText += textNodes[i].textContent + " ";
                }
                if (noteText.trim()) {
                    fullText += `[Note]: ${noteText.trim()}\n`;
                }
            }
        }
        return fullText;
    } catch (e) {
        return `[Error parsing ${file.name}]\n`;
    }
};

const extractTextFromDOCX = async (file: File): Promise<string> => {
    try {
        const zip = await JSZip.loadAsync(file);
        const content = await zip.file("word/document.xml").async("string");
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, "text/xml");
        const textNodes = xmlDoc.getElementsByTagName("w:t");
        let fullText = `[File: ${file.name}]\n`;
        for (let i = 0; i < textNodes.length; i++) {
            fullText += textNodes[i].textContent + " ";
        }
        return fullText;
    } catch (e) {
        return `[Error parsing ${file.name}]\n`;
    }
};

const extractTextFromPDF = async (file: File): Promise<string> => {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        let fullText = `[File: ${file.name}]\n`;
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            if (pageText.trim()) {
                fullText += `[Page ${i}]: ${pageText}\n`;
            }
        }
        return fullText;
    } catch (e) {
        return `[Error parsing ${file.name}]\n`;
    }
};

const isRankingCorrect = (correct: string[], answer: string[]): boolean => {
    if (!Array.isArray(correct) || !Array.isArray(answer)) return false;
    if (correct.length !== answer.length) return false;
    const normalize = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
    return correct.every((item, index) => normalize(item) === normalize(answer[index]));
};

const generateHash = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
};

// --- Components ---

const App = () => {
  const [quizState, setQuizState] = useState<QuizState>('SETUP');
  const [materialText, setMaterialText] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  const [config, setConfig] = useState<QuizConfig>({
    type: 'MIXED',
    count: 20, // Default to 20
    enableSummary: true,
    enableTopicFilter: false
  });

  const [availableTopics, setAvailableTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [isAnalyzingTopics, setIsAnalyzingTopics] = useState(false);
  const [quizSummary, setQuizSummary] = useState<SummaryConcept[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<UserAnswer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [rankingOrder, setRankingOrder] = useState<string[]>([]);
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats>({ requests: 0, inputTokens: 0, outputTokens: 0 });
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);
  const [srsDueCount, setSrsDueCount] = useState(0);
  const mainContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    updateSRSStats();
  }, [quizState]);

  useEffect(() => {
    if (questions.length > 0 && currentQuestionIndex < questions.length) {
      const currentQ = questions[currentQuestionIndex];
      if (currentQ.type === 'RANKING' && currentQ.options) {
        setRankingOrder([...currentQ.options]);
      }
    }
  }, [currentQuestionIndex, questions]);

  useEffect(() => {
    if (mainContainerRef.current) mainContainerRef.current.focus();
  }, [quizState]);

  const extractTopics = async () => {
    if (!materialText.trim() && !transcriptText.trim()) {
        setError("Please provide content to scan for topics.");
        return;
    }
    setIsAnalyzingTopics(true);
    setError(null);
    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const parts: any[] = [];
        const fullContent = `=== MATERIALS ===\n${materialText}\n=== TRANSCRIPT ===\n${transcriptText}`;
        parts.push({ text: `Analyze the following content and list 8-15 distinct main topics or themes. Content:\n\n${fullContent}` });
        const schema = {
            type: Type.OBJECT,
            properties: {
                topics: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ["topics"]
        };
        const response = await callGeminiWithRetry(ai, {
            model: MODEL_NAME,
            contents: { parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
                systemInstruction: "You are a content analyzer. List topics concisely."
            }
        });
        const usage = response.usageMetadata;
        if (usage) setUsageStats(prev => ({ requests: prev.requests + 1, inputTokens: prev.inputTokens + (usage.promptTokenCount || 0), outputTokens: prev.outputTokens + (usage.candidatesTokenCount || 0) }));
        const data = JSON.parse(response.text || "{}");
        if (data.topics && Array.isArray(data.topics)) {
            setAvailableTopics(data.topics);
            setSelectedTopics(data.topics);
            setQuizState('TOPIC_SELECTION');
        }
    } catch (err: any) {
        setError("Failed to analyze topics. Try generating without filters.");
    } finally {
        setIsAnalyzingTopics(false);
    }
  };

  const generateQuiz = async () => {
    if (!materialText.trim() && !transcriptText.trim()) {
      setError("Please provide content to generate questions.");
      return;
    }
    setQuizState('GENERATING');
    setError(null);
    setQuizSummary([]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const parts: any[] = [];
      const fullContent = `=== MATERIALS ===\n${materialText}\n=== TRANSCRIPT ===\n${transcriptText}`;
      let contextPrompt = `Content context:\n\n${fullContent}`;
      if (config.enableTopicFilter && selectedTopics.length > 0) {
          contextPrompt += `\n\nFOCUS TOPICS: ${selectedTopics.join(', ')}`;
      }
      parts.push({ text: contextPrompt });

      const questionItemSchema = {
          type: Type.OBJECT,
          properties: {
              text: { type: Type.STRING },
              explanation: { type: Type.STRING },
              type: { type: Type.STRING, enum: ["TRUE_FALSE", "MULTIPLE_CHOICE", "RANKING"] },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              correctAnswerBoolean: { type: Type.BOOLEAN },
              correctAnswerString: { type: Type.STRING },
              correctAnswerArray: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["type", "text", "explanation"]
      };

      const finalSchema = {
          type: Type.OBJECT,
          properties: {
            keyConcepts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  emoji: { type: Type.STRING },
                  points: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["title", "emoji", "points"]
              }
            },
            questions: { type: Type.ARRAY, items: questionItemSchema }
          },
          required: ["questions"]
      };

      const taskDescription = `
        Create exactly ${config.count} university-level questions.
        
        CRITICAL RULES:
        1. **Conceptual Depth**: Do not ask for simple recall. Ask for mechanisms (how X causes Y), definitions in context, or distinctions between similar concepts.
        2. **Challenge Level**: Questions should be challenging and target common misconceptions or "easy to confuse" points found in the material.
        3. **MCQ Standard**: Exactly 4 plausible options. One indisputably correct answer. No "All of the above".
        4. **Tone**: Clinical, academic, and precise.
        5. **Source Material**: Only use the provided materials and notes.
      `;

      parts.push({ text: taskDescription });

      const response = await callGeminiWithRetry(ai, {
        model: MODEL_NAME,
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          responseSchema: finalSchema,
          systemInstruction: "You are a senior university professor. Create a rigorous final exam based on the provided material. Ensure the JSON is valid."
        }
      });

      const usage = response.usageMetadata;
      if (usage) setUsageStats(prev => ({ requests: prev.requests + 1, inputTokens: prev.inputTokens + (usage.promptTokenCount || 0), outputTokens: prev.outputTokens + (usage.candidatesTokenCount || 0) }));

      const data = JSON.parse(response.text || "{}");
      if (config.enableSummary) setQuizSummary(data.keyConcepts || []);
      
      const parsedQuestions = data.questions || [];
      if (parsedQuestions.length === 0) throw new Error("No questions generated.");

      const formattedQuestions: Question[] = parsedQuestions.map((q: any, index: number) => {
        let type = q.type as QuestionType;
        let finalAnswer: any;
        if (type === 'TRUE_FALSE') finalAnswer = q.correctAnswerBoolean ?? (String(q.correctAnswerString).toLowerCase() === 'true');
        else if (type === 'RANKING') finalAnswer = q.correctAnswerArray || q.options;
        else finalAnswer = q.correctAnswerString || q.options?.[0];

        return {
          id: index,
          type,
          text: q.text,
          options: q.options || [],
          correctAnswer: finalAnswer,
          explanation: q.explanation
        };
      });

      setQuestions(formattedQuestions);
      setCurrentQuestionIndex(0);
      setUserAnswers([]);
      setQuizState(config.enableSummary && data.keyConcepts?.length > 0 ? 'KNOWLEDGE' : 'PLAYING');
    } catch (err: any) {
      setError(err.message || "Failed to generate quiz. Try reducing question count or content size.");
      setQuizState('SETUP');
    }
  };

  const updateSRSStats = () => {
    try {
        const raw = localStorage.getItem(SRS_STORAGE_KEY);
        if (raw) {
            const data: Record<string, SRSItem> = JSON.parse(raw);
            const count = Object.values(data).filter(item => item.nextReview <= Date.now()).length;
            setSrsDueCount(count);
        }
    } catch (e) {}
  };

  const handleSRSUpdate = (question: Question, isCorrect: boolean) => {
    try {
        const raw = localStorage.getItem(SRS_STORAGE_KEY);
        const data: Record<string, SRSItem> = raw ? JSON.parse(raw) : {};
        const id = generateHash(question.text);
        const existing = data[id];
        if (!existing && isCorrect) return;
        const now = Date.now();
        let newItem: SRSItem;
        if (isCorrect) {
            const currentInterval = existing ? existing.interval : 0;
            let nextInterval = 1;
            if (currentInterval >= 1) nextInterval = 3;
            if (currentInterval >= 3) nextInterval = 7;
            if (currentInterval >= 7) nextInterval = 14;
            newItem = { id, question, interval: nextInterval, repetition: (existing?.repetition || 0) + 1, nextReview: now + (nextInterval * 86400000) };
        } else {
            newItem = { id, question, interval: 0, repetition: 0, nextReview: now };
        }
        data[id] = newItem;
        localStorage.setItem(SRS_STORAGE_KEY, JSON.stringify(data));
        updateSRSStats();
    } catch (e) {}
  };

  const startReviewSession = () => {
    const raw = localStorage.getItem(SRS_STORAGE_KEY);
    if (!raw) return;
    const data: Record<string, SRSItem> = JSON.parse(raw);
    const dueItems = Object.values(data).filter(item => item.nextReview <= Date.now());
    if (dueItems.length === 0) return;
    setQuestions(dueItems.map((item, i) => ({ ...item.question, id: i })));
    setQuizSummary([]);
    setCurrentQuestionIndex(0);
    setUserAnswers([]);
    setQuizState('PLAYING');
  };

  const handleMaterialUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;
    setIsProcessingFile(true);
    try {
      let newText = "";
      for (const file of Array.from(files) as File[]) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.pptx')) newText += await extractTextFromPPTX(file);
        else if (lower.endsWith('.docx')) newText += await extractTextFromDOCX(file);
        else if (lower.endsWith('.pdf')) newText += await extractTextFromPDF(file);
        else newText += `\n[File: ${file.name}]\n${await file.text()}\n`;
      }
      setMaterialText(prev => prev + "\n" + newText);
    } finally { setIsProcessingFile(false); }
  };

  const handleTranscriptUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;
    setIsProcessingFile(true);
    try {
      let newText = "";
      for (const file of Array.from(files) as File[]) {
        let raw = await file.text();
        if (file.name.toLowerCase().endsWith('.vtt')) raw = cleanVTT(raw);
        newText += `\n[Transcript: ${file.name}]\n${raw}\n`;
      }
      setTranscriptText(prev => prev + "\n" + newText);
    } finally { setIsProcessingFile(false); }
  };

  const handleAnswer = (answer: any) => {
    const question = questions[currentQuestionIndex];
    let isCorrect = false;
    if (question.type === 'RANKING') isCorrect = isRankingCorrect(question.correctAnswer as string[], answer);
    else isCorrect = String(answer).toLowerCase() === String(question.correctAnswer).toLowerCase();
    handleSRSUpdate(question, isCorrect);
    setUserAnswers(prev => [...prev, { questionId: question.id, answer, isCorrect }]);
  };

  const nextQuestion = () => {
    if (currentQuestionIndex < questions.length - 1) setCurrentQuestionIndex(prev => prev + 1);
    else setQuizState('SUMMARY');
  };

  const moveRankItem = (index: number, direction: 'up' | 'down') => {
    const newOrder = [...rankingOrder];
    const swap = direction === 'up' ? index - 1 : index + 1;
    if (swap < 0 || swap >= newOrder.length) return;
    [newOrder[index], newOrder[swap]] = [newOrder[swap], newOrder[index]];
    setRankingOrder(newOrder);
  };

  const handleExportMistakes = () => {
    const wrong = userAnswers.filter(ua => !ua.isCorrect);
    let md = `# Quiz Review Mistakes\n\n`;
    wrong.forEach((ua, i) => {
      const q = questions.find(q => q.id === ua.questionId)!;
      md += `## ${i+1}. ${q.text}\n**Your Ans:** ${ua.answer}\n**Correct:** ${q.correctAnswer}\n**Exp:** ${q.explanation}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'mistakes.md'; a.click();
  };

  // --- Sub-Renders ---

  const renderInfo = () => isInfoOpen && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl p-6 max-w-lg w-full mx-4 shadow-2xl animate-in zoom-in-95">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2"><Info className="text-blue-600" /> Help & Tips</h3>
          <button onClick={() => setIsInfoOpen(false)}><X /></button>
        </div>
        <div className="space-y-4 text-sm text-gray-600">
          <p><strong>Overload Errors:</strong> If you see "Model Overloaded", it means Gemini is currently busy. The app will automatically retry with exponential backoff.</p>
          <p><strong>Question Logic:</strong> The AI is instructed to focus on mechanisms and conceptual distinctions rather than trivial facts.</p>
          <p><strong>SRS:</strong> Mistakes are saved locally for spaced repetition review.</p>
        </div>
        <button onClick={() => setIsInfoOpen(false)} className="mt-6 w-full py-2 bg-gray-900 text-white rounded-xl">Got it</button>
      </div>
    </div>
  );

  const renderStats = () => isStatsOpen && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl animate-in zoom-in-95">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold flex items-center gap-2"><Activity className="text-purple-600" /> API Usage</h3>
          <button onClick={() => setIsStatsOpen(false)}><X /></button>
        </div>
        <div className="space-y-3">
          <div className="flex justify-between"><span>Requests:</span> <b>{usageStats.requests}</b></div>
          <div className="flex justify-between"><span>Total Tokens:</span> <b>{(usageStats.inputTokens + usageStats.outputTokens).toLocaleString()}</b></div>
        </div>
      </div>
    </div>
  );

  if (quizState === 'SETUP') return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
      <button onClick={() => setIsInfoOpen(true)} className="fixed top-4 right-16 p-2 bg-white rounded-full shadow-md"><CircleHelp className="w-5 h-5 text-gray-500" /></button>
      <button onClick={() => setIsStatsOpen(true)} className="fixed top-4 right-4 p-2 bg-white rounded-full shadow-md"><Activity className="w-5 h-5 text-gray-500" /></button>
      {renderInfo()} {renderStats()}
      <div className="max-w-6xl w-full bg-white rounded-3xl shadow-2xl overflow-hidden border border-gray-100">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 p-8 text-white">
          <h1 className="text-3xl font-bold flex items-center gap-3"><Brain /> Gemini Quiz Master</h1>
          <p className="mt-2 opacity-80">Higher education question generation with automated retry & SRS support.</p>
        </div>
        <div className="p-8 space-y-8">
          {srsDueCount > 0 && (
            <div className="bg-purple-50 p-4 rounded-2xl flex items-center justify-between border border-purple-100">
              <div className="flex items-center gap-4">
                <History className="text-purple-600" />
                <div><h3 className="font-bold">Spaced Repetition Review</h3><p className="text-sm text-gray-500">{srsDueCount} questions due for review.</p></div>
              </div>
              <button onClick={startReviewSession} className="px-4 py-2 bg-purple-600 text-white rounded-xl text-sm font-bold">Start Review</button>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-4">
              <label className="text-sm font-bold text-gray-700 flex items-center gap-2"><FileText className="w-4 h-4" /> Materials (PPTX, PDF, DOCX)</label>
              <div className="border-2 border-dashed border-gray-200 rounded-2xl p-6 text-center bg-gray-50/50 hover:border-blue-500 transition-colors relative">
                <input type="file" multiple onChange={handleMaterialUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <Upload className="mx-auto mb-2 text-gray-400" />
                <span className="text-sm text-gray-500">Click or drag files here</span>
              </div>
              <textarea className="w-full h-64 p-4 rounded-2xl bg-gray-50 border-none focus:ring-2 focus:ring-blue-500 text-sm" placeholder="Or paste content directly..." value={materialText} onChange={(e) => setMaterialText(e.target.value)} />
            </div>
            <div className="space-y-4">
              <label className="text-sm font-bold text-gray-700 flex items-center gap-2"><Mic className="w-4 h-4" /> Transcript / VTT</label>
              <div className="border-2 border-dashed border-gray-200 rounded-2xl p-6 text-center bg-gray-50/50 hover:border-purple-500 transition-colors relative">
                <input type="file" multiple onChange={handleTranscriptUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <Upload className="mx-auto mb-2 text-gray-400" />
                <span className="text-sm text-gray-500">Upload transcripts</span>
              </div>
              <textarea className="w-full h-64 p-4 rounded-2xl bg-gray-50 border-none focus:ring-2 focus:ring-purple-500 text-sm" placeholder="Paste speech transcript..." value={transcriptText} onChange={(e) => setTranscriptText(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 bg-gray-50 rounded-3xl">
            <div className="space-y-4">
              <span className="text-sm font-bold text-gray-700">Quiz Type</span>
              <div className="grid grid-cols-3 gap-2">
                {['MIXED', 'MULTIPLE_CHOICE', 'TRUE_FALSE'].map(t => (
                  <button key={t} onClick={() => setConfig({...config, type: t as any})} className={`py-2 rounded-xl text-xs font-bold transition-all ${config.type === t ? 'bg-indigo-600 text-white shadow-lg' : 'bg-white text-gray-500 border border-gray-200'}`}>{t.replace('_', ' ')}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-col justify-center gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-gray-700">Study Summary</span>
                <button onClick={() => setConfig({...config, enableSummary: !config.enableSummary})} className={`w-12 h-6 rounded-full relative transition-colors ${config.enableSummary ? 'bg-green-500' : 'bg-gray-300'}`}><div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${config.enableSummary ? 'translate-x-7' : 'translate-x-1'}`} /></button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-gray-700">Question Count: <b>{config.count}</b></span>
                <input type="range" min="5" max="30" value={config.count} onChange={(e) => setConfig({...config, count: parseInt(e.target.value)})} className="w-32" />
              </div>
            </div>
          </div>
          {error && <div className="p-4 bg-red-50 text-red-600 rounded-2xl text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}
          <button onClick={generateQuiz} disabled={isProcessingFile} className="w-full py-4 bg-gray-900 hover:bg-black text-white rounded-2xl font-bold text-lg shadow-xl transition-all flex items-center justify-center gap-2">
            {isProcessingFile ? <Loader2 className="animate-spin" /> : <><Sparkles className="w-5 h-5" /> Generate Academic Quiz</>}
          </button>
        </div>
      </div>
    </div>
  );

  if (quizState === 'GENERATING') return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center animate-pulse">
      <Loader2 className="w-16 h-16 text-indigo-600 animate-spin mb-6" />
      <h2 className="text-2xl font-bold text-gray-800">Processing with Gemini 2.5 Flash</h2>
      <p className="text-gray-500 mt-2">Identifying mechanisms, causality, and key academic concepts...</p>
    </div>
  );

  if (quizState === 'KNOWLEDGE') return (
    <div className="min-h-screen bg-gray-50 p-6 flex items-center justify-center fade-in">
      <div className="max-w-4xl w-full bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 bg-indigo-50 border-b border-indigo-100 flex justify-between items-center">
          <div><h2 className="text-2xl font-bold text-indigo-900">Knowledge Summary</h2><p className="text-sm text-indigo-600">Quick review before the exam starts.</p></div>
          <button onClick={() => setQuizState('PLAYING')} className="px-8 py-3 bg-indigo-600 text-white rounded-2xl font-bold shadow-lg shadow-indigo-200 flex items-center gap-2">Start Quiz <Play className="w-4 h-4 fill-current" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-8 grid grid-cols-1 md:grid-cols-2 gap-6 custom-scrollbar">
          {quizSummary.map((c, i) => (
            <div key={i} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-center gap-3 mb-4"><span className="text-2xl">{c.emoji}</span><h3 className="font-bold text-gray-800">{c.title}</h3></div>
              <ul className="space-y-2">{c.points.map((p, j) => <li key={j} className="text-sm text-gray-600 flex gap-2"><div className="w-1.5 h-1.5 bg-indigo-400 rounded-full mt-1.5 flex-shrink-0" /> {p}</li>)}</ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (quizState === 'PLAYING') {
    const q = questions[currentQuestionIndex];
    const ans = userAnswers.find(ua => ua.questionId === q.id);
    const answered = !!ans;
    return (
      <div className="min-h-screen bg-gray-50 p-6 flex items-center justify-center fade-in">
        <div className="max-w-2xl w-full bg-white rounded-3xl shadow-2xl overflow-hidden">
          <div className="h-1.5 bg-gray-100 w-full"><div className="h-full bg-indigo-600 transition-all duration-500" style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }} /></div>
          <div className="p-8">
            <div className="flex justify-between items-center mb-8">
              <span className="px-3 py-1 bg-indigo-50 text-indigo-600 text-xs font-bold rounded-full uppercase tracking-widest">{q.type.replace('_', ' ')}</span>
              <span className="text-gray-400 font-bold">{currentQuestionIndex + 1} / {questions.length}</span>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-8 leading-tight">{q.text}</h2>
            <div className="space-y-3 mb-10">
              {q.type === 'TRUE_FALSE' ? (
                <div className="grid grid-cols-2 gap-4">
                  {[true, false].map(v => (
                    <button key={v.toString()} disabled={answered} onClick={() => handleAnswer(v)} className={`py-6 rounded-2xl font-bold text-lg border-2 transition-all ${answered ? (String(v) === String(q.correctAnswer) ? 'bg-green-100 border-green-500 text-green-700' : (ans?.answer === v ? 'bg-red-50 border-red-300 text-red-600 opacity-50' : 'bg-white text-gray-300 opacity-50')) : 'bg-white hover:border-indigo-600 hover:bg-indigo-50'}`}>{v ? "True" : "False"}</button>
                  ))}
                </div>
              ) : q.type === 'MULTIPLE_CHOICE' ? (
                <div className="space-y-3">
                  {q.options?.map((opt, i) => (
                    <button key={i} disabled={answered} onClick={() => handleAnswer(opt)} className={`w-full p-4 rounded-2xl border-2 text-left font-medium transition-all flex justify-between items-center ${answered ? (opt === q.correctAnswer ? 'bg-green-50 border-green-500 text-green-800' : (ans?.answer === opt ? 'bg-red-50 border-red-300 text-red-700' : 'bg-white text-gray-300 opacity-50')) : 'bg-white hover:border-indigo-600 hover:bg-indigo-50'}`}>
                      <span>{opt}</span>
                      {answered && opt === q.correctAnswer && <CircleCheck className="text-green-600" />}
                      {answered && ans?.answer === opt && opt !== q.correctAnswer && <CircleX className="text-red-500" />}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {rankingOrder.map((item, i) => (
                    <div key={item} className="p-3 bg-white border-2 border-gray-100 rounded-2xl flex items-center justify-between">
                      <div className="flex items-center gap-3"><div className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold">{i+1}</div><span>{item}</span></div>
                      {!answered && <div className="flex gap-1"><button onClick={() => moveRankItem(i, 'up')} className="p-1 hover:bg-gray-100 rounded"><ArrowUp size={16}/></button><button onClick={() => moveRankItem(i, 'down')} className="p-1 hover:bg-gray-100 rounded"><ArrowDown size={16}/></button></div>}
                    </div>
                  ))}
                  {!answered && <button onClick={() => handleAnswer(rankingOrder)} className="w-full py-4 mt-4 bg-indigo-600 text-white rounded-2xl font-bold">Confirm Order</button>}
                </div>
              )}
            </div>
            {answered && (
              <div className="animate-in slide-in-from-bottom-4">
                <div className={`p-6 rounded-2xl mb-6 ${ans.isCorrect ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
                  <h4 className="font-bold mb-2">{ans.isCorrect ? '✓ Excellent!' : '✗ Concept Misunderstood'}</h4>
                  <p className="text-sm leading-relaxed opacity-90">{q.explanation}</p>
                </div>
                <button onClick={nextQuestion} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold flex items-center justify-center gap-2">Next Question <ChevronRight /></button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (quizState === 'SUMMARY') {
    const correct = userAnswers.filter(a => a.isCorrect).length;
    const pct = Math.round((correct / questions.length) * 100);
    return (
      <div className="min-h-screen bg-gray-50 p-6 flex items-center justify-center fade-in">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl p-8 text-center">
          <div className="w-32 h-32 mx-auto mb-6 rounded-full bg-indigo-50 flex items-center justify-center relative">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36"><path className="text-indigo-100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="2.5"/><path className="text-indigo-600" strokeDasharray={`${pct}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="2.5"/></svg>
            <span className="absolute text-3xl font-black text-indigo-600">{pct}%</span>
          </div>
          <h2 className="text-3xl font-bold text-gray-900 mb-2">{pct >= 80 ? "Superior Master!" : "Keep Practicing"}</h2>
          <p className="text-gray-500 mb-8 font-medium">You solved {correct} out of {questions.length} accurately.</p>
          <div className="space-y-3">
            <button onClick={() => setQuizState('REVIEW')} className="w-full py-3 bg-white border-2 border-gray-100 rounded-2xl font-bold text-gray-700 hover:border-indigo-600 transition-colors">Review Detailed Answers</button>
            {correct < questions.length && <button onClick={handleExportMistakes} className="w-full py-3 bg-red-50 text-red-600 rounded-2xl font-bold hover:bg-red-100 transition-colors">Export Mistakes (.md)</button>}
            <button onClick={() => setQuizState('SETUP')} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold shadow-lg">New Quiz Session</button>
          </div>
        </div>
      </div>
    );
  }

  if (quizState === 'REVIEW') return (
    <div className="min-h-screen bg-gray-100 p-6 fade-in">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="bg-white p-6 rounded-3xl shadow-sm flex justify-between items-center sticky top-6 z-10 border border-gray-100">
          <h2 className="text-xl font-bold">Answer Breakdown</h2>
          <button onClick={() => setQuizState('SUMMARY')} className="px-4 py-2 bg-gray-100 rounded-xl font-bold flex items-center gap-2"><ArrowLeft size={16}/> Back</button>
        </div>
        <div className="space-y-4">
          {questions.map((q, i) => {
            const ans = userAnswers.find(ua => ua.questionId === q.id);
            return (
              <div key={q.id} className={`bg-white p-8 rounded-3xl border-l-8 ${ans?.isCorrect ? 'border-green-500' : 'border-red-500'} shadow-sm`}>
                <div className="flex justify-between mb-4"><span className="text-xs font-black text-gray-300 uppercase">Question {i+1}</span></div>
                <h3 className="text-lg font-bold mb-6">{q.text}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                  <div className={`p-4 rounded-2xl ${ans?.isCorrect ? 'bg-green-50' : 'bg-red-50'}`}><span className="text-[10px] font-bold block mb-1 opacity-50 uppercase">Your Answer</span><div className="font-bold">{String(ans?.answer)}</div></div>
                  {!ans?.isCorrect && <div className="p-4 rounded-2xl bg-indigo-50"><span className="text-[10px] font-bold block mb-1 opacity-50 uppercase">Correct Answer</span><div className="font-bold text-indigo-900">{String(q.correctAnswer)}</div></div>}
                </div>
                <div className="bg-gray-50 p-4 rounded-2xl flex gap-3"><span className="text-gray-400 flex-shrink-0"><Info size={18} /></span><p className="text-sm text-gray-600 leading-relaxed">{q.explanation}</p></div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return null;
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);