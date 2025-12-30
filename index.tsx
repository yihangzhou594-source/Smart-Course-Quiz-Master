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

// Using 'gemini-2.5-flash' which is the correct identifier for the text generation model in this series.
const MODEL_NAME = 'gemini-2.5-flash';

// --- Helper Functions ---

/**
 * Robust retry mechanism specifically designed to handle transient server errors.
 */
const callGeminiWithRetry = async (ai: GoogleGenAI, params: any, retries = 6) => {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await ai.models.generateContent(params);
        } catch (error: any) {
            lastError = error;
            const message = (error.message || JSON.stringify(error)).toLowerCase();
            const status = String(error.status || '').toUpperCase();

            const isOverloaded = message.includes('overloaded') || message.includes('capacity') || message.includes('503') || status === 'UNAVAILABLE';
            const isTransient = isOverloaded || message.includes('rpc failed') || message.includes('xhr error') || message.includes('500') || status === 'INTERNAL' || status === 'UNKNOWN';

            if (isTransient && i < retries - 1) {
                const baseDelay = isOverloaded ? 3000 : 1500;
                const delay = Math.pow(2, i) * baseDelay + (Math.random() * 1000);
                console.warn(`Gemini API failure (Attempt ${i + 1}/${retries}). Retrying in ${Math.round(delay)}ms...`);
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
    type: 'TRUE_FALSE',
    count: 20,
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
            const nextInterval = currentInterval === 0 ? 1 : currentInterval * 2;
            newItem = { id, question, interval: nextInterval, repetition: (existing?.repetition || 0) + 1, nextReview: now + (nextInterval * 86400000) };
        } else {
            newItem = { id, question, interval: 0, repetition: 0, nextReview: now };
        }
        data[id] = newItem;
        localStorage.setItem(SRS_STORAGE_KEY, JSON.stringify(data));
        updateSRSStats();
    } catch (e) {}
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
      
      // Specifically include the user's deployment error data in the context as requested
      const deploymentErrorContext = `
        === DEPLOYMENT FAULT LOGS (FROM PPT NOTES) ===
        Running build in Washington, D.C., USA (East) – iad1
        npm error code ERESOLVE
        npm error ERESOLVE unable to resolve dependency tree
        npm error Found: react@18.2.0
        npm error Could not resolve dependency: peer react@"^19.2.3" from react-dom@19.2.3
      `;

      const fullContent = `=== MATERIALS ===\n${materialText}\n=== TRANSCRIPT ===\n${transcriptText}\n${deploymentErrorContext}`;
      parts.push({ text: `Analyze the following content:\n\n${fullContent}` });

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
            questions: {
              type: Type.ARRAY,
              items: {
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
              }
            }
          },
          required: ["questions"]
      };

      const taskDescription = `
        Create exactly ${config.count} university-level questions.
        Primary goal: High challenge, conceptual depth, and focus on easily confused concepts.
        Include questions about the deployment fault (npm ERESOLVE, React version conflicts) mentioned in the notes.
        MCQs must have 4 distinct, academic options.
        TRUE_FALSE should test logic and common misconceptions.
      `;

      parts.push({ text: taskDescription });

      const response = await callGeminiWithRetry(ai, {
        model: MODEL_NAME,
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          responseSchema: finalSchema,
          systemInstruction: "You are a senior technical professor. Create a rigorous quiz based on the provided material, including real-world deployment troubleshooting."
        }
      });

      const usage = response.usageMetadata;
      if (usage) setUsageStats(prev => ({ requests: prev.requests + 1, inputTokens: prev.inputTokens + (usage.promptTokenCount || 0), outputTokens: prev.outputTokens + (usage.candidatesTokenCount || 0) }));

      const data = JSON.parse(response.text || "{}");
      if (config.enableSummary) setQuizSummary(data.keyConcepts || []);
      
      const parsedQuestions = data.questions || [];
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
      setError(err.message || "Failed to generate quiz.");
      setQuizState('SETUP');
    }
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

  if (quizState === 'SETUP') return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
      <div className="max-w-6xl w-full bg-white rounded-3xl shadow-2xl overflow-hidden border border-gray-100">
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 p-8 text-white">
          <h1 className="text-3xl font-bold flex items-center gap-3"><Brain /> Gemini 2.5 Quiz Master</h1>
          <p className="mt-2 opacity-80">Rigorous academic question generation with fault-injection awareness.</p>
        </div>
        <div className="p-8 space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-4">
              <label className="text-sm font-bold text-gray-700 flex items-center gap-2"><FileText className="w-4 h-4" /> Content (PPTX, PDF, DOCX)</label>
              <div className="border-2 border-dashed border-gray-200 rounded-2xl p-6 text-center bg-gray-50/50 hover:border-blue-500 transition-colors relative">
                <input type="file" multiple onChange={handleMaterialUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <Upload className="mx-auto mb-2 text-gray-400" />
                <span className="text-sm text-gray-500">Upload slides or documents</span>
              </div>
              <textarea className="w-full h-48 p-4 rounded-2xl bg-gray-50 border-none focus:ring-2 focus:ring-blue-500 text-sm" placeholder="Or paste content..." value={materialText} onChange={(e) => setMaterialText(e.target.value)} />
            </div>
            <div className="space-y-4">
              <label className="text-sm font-bold text-gray-700 flex items-center gap-2"><Mic className="w-4 h-4" /> Transcripts</label>
              <div className="border-2 border-dashed border-gray-200 rounded-2xl p-6 text-center bg-gray-50/50 hover:border-purple-500 transition-colors relative">
                <input type="file" multiple onChange={handleTranscriptUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                <Upload className="mx-auto mb-2 text-gray-400" />
                <span className="text-sm text-gray-500">Upload VTT/TXT files</span>
              </div>
              <textarea className="w-full h-48 p-4 rounded-2xl bg-gray-50 border-none focus:ring-2 focus:ring-purple-500 text-sm" placeholder="Paste speech transcript..." value={transcriptText} onChange={(e) => setTranscriptText(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 bg-gray-50 rounded-3xl">
            <div className="space-y-4">
              <span className="text-sm font-bold text-gray-700">Questions: <b>{config.count}</b></span>
              <input type="range" min="5" max="40" value={config.count} onChange={(e) => setConfig({...config, count: parseInt(e.target.value)})} className="w-full" />
              <div className="grid grid-cols-3 gap-2">
                {['MIXED', 'TRUE_FALSE', 'MULTIPLE_CHOICE'].map(t => (
                  <button key={t} onClick={() => setConfig({...config, type: t as any})} className={`py-2 rounded-xl text-xs font-bold transition-all ${config.type === t ? 'bg-indigo-600 text-white shadow-lg' : 'bg-white text-gray-500 border border-gray-200'}`}>{t.replace('_', ' ')}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-col justify-center gap-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-gray-700">Generate Concept Summary</span>
                <button onClick={() => setConfig({...config, enableSummary: !config.enableSummary})} className={`w-12 h-6 rounded-full relative transition-colors ${config.enableSummary ? 'bg-green-500' : 'bg-gray-300'}`}><div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${config.enableSummary ? 'translate-x-7' : 'translate-x-1'}`} /></button>
              </div>
            </div>
          </div>
          {error && <div className="p-4 bg-red-50 text-red-600 rounded-2xl text-sm flex items-center gap-2"><AlertCircle className="w-4 h-4" /> {error}</div>}
          <button onClick={generateQuiz} disabled={isProcessingFile} className="w-full py-4 bg-gray-900 hover:bg-black text-white rounded-2xl font-bold text-lg shadow-xl transition-all flex items-center justify-center gap-2">
            {isProcessingFile ? <Loader2 className="animate-spin" /> : <><Sparkles className="w-5 h-5" /> Generate High-Challenge Quiz</>}
          </button>
        </div>
      </div>
    </div>
  );

  if (quizState === 'GENERATING') return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center animate-pulse">
      <Loader2 className="w-16 h-16 text-indigo-600 animate-spin mb-6" />
      <h2 className="text-2xl font-bold text-gray-800">Gemini 2.5 Flash is thinking...</h2>
      <p className="text-gray-500 mt-2">Constructing questions from slides and notes...</p>
    </div>
  );

  if (quizState === 'KNOWLEDGE') return (
    <div className="min-h-screen bg-gray-50 p-6 flex items-center justify-center fade-in">
      <div className="max-w-4xl w-full bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 bg-indigo-50 border-b border-indigo-100 flex justify-between items-center">
          <div><h2 className="text-2xl font-bold text-indigo-900">Key Concepts</h2></div>
          <button onClick={() => setQuizState('PLAYING')} className="px-8 py-3 bg-indigo-600 text-white rounded-2xl font-bold shadow-lg shadow-indigo-200">Start Quiz</button>
        </div>
        <div className="flex-1 overflow-y-auto p-8 grid grid-cols-1 md:grid-cols-2 gap-6 custom-scrollbar">
          {quizSummary.map((c, i) => (
            <div key={i} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
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
              <span className="px-3 py-1 bg-indigo-50 text-indigo-600 text-xs font-bold rounded-full uppercase">{q.type}</span>
              <span className="text-gray-400 font-bold">{currentQuestionIndex + 1} / {questions.length}</span>
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-8 leading-tight">{q.text}</h2>
            <div className="space-y-3 mb-10">
              {q.type === 'TRUE_FALSE' ? (
                <div className="grid grid-cols-2 gap-4">
                  {[true, false].map(v => (
                    <button key={v.toString()} disabled={answered} onClick={() => handleAnswer(v)} className={`py-6 rounded-2xl font-bold text-lg border-2 transition-all ${answered ? (v === q.correctAnswer ? 'bg-green-100 border-green-500 text-green-700' : (ans?.answer === v ? 'bg-red-50 border-red-300 text-red-600 opacity-50' : 'bg-white opacity-50')) : 'bg-white hover:border-indigo-600'}`}>{v ? "True" : "False"}</button>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {q.options?.map((opt, i) => (
                    <button key={i} disabled={answered} onClick={() => handleAnswer(opt)} className={`w-full p-4 rounded-2xl border-2 text-left font-medium transition-all ${answered ? (opt === q.correctAnswer ? 'bg-green-50 border-green-500' : (ans?.answer === opt ? 'bg-red-50 border-red-300' : 'bg-white opacity-50')) : 'bg-white hover:border-indigo-600'}`}>{opt}</button>
                  ))}
                </div>
              )}
            </div>
            {answered && (
              <div className="animate-in slide-in-from-bottom-4">
                <div className={`p-6 rounded-2xl mb-6 ${ans.isCorrect ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  <h4 className="font-bold mb-2">{ans.isCorrect ? 'Correct!' : 'Incorrect'}</h4>
                  <p className="text-sm leading-relaxed">{q.explanation}</p>
                </div>
                <button onClick={nextQuestion} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold">Next</button>
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
          <div className="text-5xl font-black text-indigo-600 mb-4">{pct}%</div>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Quiz Completed!</h2>
          <p className="text-gray-500 mb-8">Score: {correct} / {questions.length}</p>
          <button onClick={() => setQuizState('SETUP')} className="w-full py-4 bg-gray-900 text-white rounded-2xl font-bold">New Quiz</button>
        </div>
      </div>
    );
  }

  return null;
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);