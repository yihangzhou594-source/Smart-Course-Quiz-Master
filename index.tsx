import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Upload, FileText, CheckCircle, XCircle, Brain, RefreshCw, Play, ChevronRight, AlertCircle, Loader2, Trash2, ListChecks, ToggleLeft, Shuffle, BookOpen, Sparkles, Info, ArrowUp, ArrowDown, Eye, ArrowLeft, Check, X, Download, Activity, Mic, Eraser, Settings2, GripVertical } from 'lucide-react';

// --- Globals ---
declare const JSZip: any;

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

type SummaryConcept = {
  title: string;
  emoji: string;
  points: string[];
};

type QuizState = 'SETUP' | 'GENERATING' | 'KNOWLEDGE' | 'PLAYING' | 'SUMMARY' | 'REVIEW';

type UserAnswer = {
  questionId: number;
  answer: boolean | string | string[];
  isCorrect: boolean;
};

type QuizConfig = {
  type: QuestionType;
  count: number;
  enableSummary: boolean;
};

type UsageStats = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

// --- Constants ---

const MODEL_NAME = 'gemini-2.5-flash';

// --- Helper Functions ---

const cleanVTT = (text: string): string => {
  // Remove WEBVTT header
  let clean = text.replace(/WEBVTT\s?(\w*)\n/g, '');
  // Remove timestamps (00:00:00.000 --> 00:00:00.000)
  clean = clean.replace(/(\d{2}:)?\d{2}:\d{2}\.\d{3} --> (\d{2}:)?\d{2}:\d{2}\.\d{3}.*\n/g, '');
  // Remove voice tags like <v Name>
  clean = clean.replace(/<[^>]*>/g, '');
  // Remove empty lines and excess whitespace
  return clean.split('\n').map(l => l.trim()).filter(l => l).join('\n');
};

const extractTextFromPPTX = async (file: File): Promise<string> => {
    try {
        const zip = await JSZip.loadAsync(file);
        
        // 1. Extract Slide Content
        const slideFiles = Object.keys(zip.files).filter(name => name.match(/ppt\/slides\/slide\d+\.xml/));
        
        // Sort slides by number
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
            // PowerPoint stores text in <a:t> tags
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

        // 2. Extract Speaker Notes (Crucial for details/exceptions)
        const noteFiles = Object.keys(zip.files).filter(name => name.match(/ppt\/notesSlides\/notesSlide\d+\.xml/));
        
        if (noteFiles.length > 0) {
            fullText += `\n=== SPEAKER NOTES / FOOTNOTES (Important for nuance) ===\n`;
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
        console.error("PPTX Parse Error", e);
        return `[Error parsing ${file.name}. Please try exporting as PDF or Text.]\n`;
    }
};

const extractTextFromDOCX = async (file: File): Promise<string> => {
    try {
        const zip = await JSZip.loadAsync(file);
        const content = await zip.file("word/document.xml").async("string");
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, "text/xml");
        // Word stores text in <w:t> tags
        const textNodes = xmlDoc.getElementsByTagName("w:t");
        
        let fullText = `[File: ${file.name}]\n`;
        for (let i = 0; i < textNodes.length; i++) {
            fullText += textNodes[i].textContent + " ";
        }
        return fullText;
    } catch (e) {
        console.error("DOCX Parse Error", e);
        return `[Error parsing ${file.name}]\n`;
    }
};

// Robust Array Comparison
const isRankingCorrect = (correct: string[], answer: string[]): boolean => {
    if (!Array.isArray(correct) || !Array.isArray(answer)) return false;
    if (correct.length !== answer.length) return false;
    
    // Normalize strings: remove extra spaces, lowercase
    const normalize = (s: string) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
    
    return correct.every((item, index) => normalize(item) === normalize(answer[index]));
};

// --- Components ---

const App = () => {
  const [quizState, setQuizState] = useState<QuizState>('SETUP');
  
  // Content State
  const [materialText, setMaterialText] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  
  // Settings State
  const [config, setConfig] = useState<QuizConfig>({
    type: 'MIXED',
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
  
  // Ranking Interaction State
  const [rankingOrder, setRankingOrder] = useState<string[]>([]);
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);

  // Stats State
  const [usageStats, setUsageStats] = useState<UsageStats>({ requests: 0, inputTokens: 0, outputTokens: 0 });
  const [isStatsOpen, setIsStatsOpen] = useState(false);

  // --- Effects ---

  // Initialize ranking order when a ranking question appears
  useEffect(() => {
    if (questions.length > 0 && currentQuestionIndex < questions.length) {
      const currentQ = questions[currentQuestionIndex];
      if (currentQ.type === 'RANKING' && currentQ.options) {
        setRankingOrder([...currentQ.options]);
      }
    }
  }, [currentQuestionIndex, questions]);

  // --- Gemini Logic ---

  const generateQuiz = async () => {
    if (!materialText.trim() && !transcriptText.trim()) {
      setError("Please provide content (Materials or Transcripts) to generate questions.");
      return;
    }

    setQuizState('GENERATING');
    setError(null);
    setQuizSummary([]);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const parts: any[] = [];
      
      const fullContent = `
=== VISUAL MATERIALS (Slides/Docs/Notes) ===
${materialText}

=== VERBAL TRANSCRIPT (Speech) ===
${transcriptText}
      `;

      parts.push({ text: `Here is the combined content extracted from the user's files:\n\n${fullContent}` });
      
      // Dynamic Prompt Construction
      let taskDescription = "";
      
      const baseProperties = {
        text: { type: Type.STRING, description: "The question text." },
        explanation: { type: Type.STRING, description: "Detailed explanation of the answer." }
      };

      if (config.type === 'TRUE_FALSE') {
        taskDescription = `
          Create exactly ${config.count} "True or False" judgment questions.
          
          *** CRITICAL STYLE INSTRUCTIONS (HARD MODE) ***
          The user wants challenging "trick" questions that test deep understanding and attention to detail.
          
          GENERATE QUESTIONS USING THESE PATTERNS:
          1. **Concept Swapping**: Take a definition of Concept A but name it Concept B. (e.g. "The Law of Segregation states that alleles of different genes segregate independently" -> FALSE, that is Independent Assortment).
          2. **Detail Reversal**: Change a specific detail in a factual sentence. (e.g. "Hydrogen ions are pumped to the matrix" -> FALSE, they are pumped to the intermembrane space).
          3. **Exceptions & Footnotes**: Use content specifically found in the "SPEAKER NOTES" or footnotes. (e.g. "RBCs contain mitochondria" -> FALSE, notes say they don't).
          4. **Cis vs Trans / Alpha vs Beta**: Swap opposing terms.
          
          REQUIREMENTS:
          - Approximately 50-60% of answers should be FALSE (these are better for learning).
          - The Explanation must clearly state WHY it is false and correct the specific error.
          - Questions must be challenging (>30% error rate style).
        `;
      } else if (config.type === 'MULTIPLE_CHOICE') {
        taskDescription = `
          Create exactly ${config.count} Multiple Choice Questions (MCQ).
          - Each question must have 4 distinct options.
          - Only ONE option should be correct.
          - Distractors (wrong answers) should be plausible.
        `;
      } else {
        taskDescription = `
          Create exactly ${config.count} questions using a SMART MIX of types.
          
          DISTRIBUTION RULES:
          1. Mostly Multiple Choice (MCQ) and True/False (T/F).
          2. **RANKING/SORTING Questions**: Include MAX 2 ranking questions per 15 items.
             - ONLY generate a Ranking question if the content involves a clear sequential process, timeline, steps, or hierarchy.
             - If no such content exists, do NOT force a Ranking question; use MCQ instead.
          
          TYPES:
          - TRUE_FALSE: Challenging boolean judgment (use 'Hard Mode' style: swapping concepts, trick details).
          - MULTIPLE_CHOICE: 4 options, 1 correct.
          - RANKING: Provide 3-5 items that must be ordered. 
            - 'options' field must contain the items in a RANDOM/SCRAMBLED order.
            - 'correctAnswerArray' field must contain the items in the CORRECT order.
            - **CRITICAL**: The strings in 'correctAnswerArray' MUST BE IDENTICAL to the strings in 'options'. Do not add numbering or extra text.
        `;
      }

      // Robust Schema Definition that allows for flexibility
      const questionItemSchema = {
          type: Type.OBJECT,
          properties: {
              ...baseProperties,
              type: { type: Type.STRING, enum: ["TRUE_FALSE", "MULTIPLE_CHOICE", "RANKING"] },
              options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "MCQ choices OR Ranking items (scrambled)." },
              // We ask for specific fields, but the parser will look for fallbacks
              correctAnswerBoolean: { type: Type.BOOLEAN, description: "For TRUE_FALSE only." },
              correctAnswerString: { type: Type.STRING, description: "For MULTIPLE_CHOICE only." },
              correctAnswerArray: { type: Type.ARRAY, items: { type: Type.STRING }, description: "For RANKING only (correct order). Must match strings in 'options' exactly." }
          },
          required: ["type", "text", "explanation"]
      };

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
              items: questionItemSchema
            }
          },
          required: ["keyConcepts", "questions"]
        };
      } else {
        finalSchema = {
          type: Type.ARRAY,
          items: questionItemSchema
        };
      }

      const prompt = `
        You are a strict university-level exam creator.
        
        TASK:
        Analyze the provided content (slides, notes, transcripts).
        ${config.enableSummary ? "First, extract key concepts." : ""}
        Then, ${taskDescription}
        
        CRITICAL GUIDELINES:
        1. **High Difficulty**: Questions should test deep understanding, not just surface recall.
        2. **Notes Usage**: You MUST incorporate details found in the [Note] sections of the text (footnotes, speaker notes) to create challenging questions.
        3. **Parsing**: Ensure you fill the correct fields for the chosen question type.
        4. **RANKING**: Ensure 'correctAnswerArray' uses the EXACT SAME STRINGS as 'options'.

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

      // Track Usage
      const usage = response.usageMetadata;
      if (usage) {
        setUsageStats(prev => ({
            requests: prev.requests + 1,
            inputTokens: prev.inputTokens + (usage.promptTokenCount || 0),
            outputTokens: prev.outputTokens + (usage.candidatesTokenCount || 0)
        }));
      }

      const rawText = response.text || "{}";
      const generatedData = JSON.parse(rawText);
      
      let parsedQuestions: any[] = [];

      if (config.enableSummary) {
         if (!generatedData.questions || !Array.isArray(generatedData.questions)) {
             // Fallback if schema was ignored and array was returned directly
             if (Array.isArray(generatedData)) {
                parsedQuestions = generatedData;
             } else {
                throw new Error("Questions were not generated properly.");
             }
         } else {
             setQuizSummary(generatedData.keyConcepts || []);
             parsedQuestions = generatedData.questions;
         }
      } else {
         if (Array.isArray(generatedData)) {
             parsedQuestions = generatedData;
         } else if (generatedData.questions && Array.isArray(generatedData.questions)) {
             parsedQuestions = generatedData.questions;
         } else {
             throw new Error("Questions were not generated properly.");
         }
      }

      const formattedQuestions: Question[] = parsedQuestions.map((q: any, index: number) => {
        // --- ROBUST PARSING LOGIC ---
        
        // 1. Determine Type
        let type: QuestionType = q.type;
        // Infer type if missing
        if (!type) {
            if (q.correctAnswerBoolean !== undefined || q.correctAnswerBoolean !== null) type = 'TRUE_FALSE';
            else if (Array.isArray(q.correctAnswerArray)) type = 'RANKING';
            else type = 'MULTIPLE_CHOICE';
        }
        
        // Normalize strings
        if (type === 'Multiple Choice' as any || type === 'MCQ' as any) type = 'MULTIPLE_CHOICE';
        if (type === 'True False' as any || type === 'True/False' as any) type = 'TRUE_FALSE';
        if (type === 'Ranking' as any) type = 'RANKING';
        
        // 2. Extract Answer with Fallbacks
        let finalAnswer: any;

        if (type === 'TRUE_FALSE') {
          // Check specific field first
          if (typeof q.correctAnswerBoolean === 'boolean') finalAnswer = q.correctAnswerBoolean;
          // Check generic fields
          else if (typeof q.answer === 'boolean') finalAnswer = q.answer;
          else if (typeof q.correctAnswer === 'boolean') finalAnswer = q.correctAnswer;
          // Check string representations
          else if (String(q.correctAnswerBoolean).toLowerCase() === 'true') finalAnswer = true;
          else if (String(q.correctAnswerBoolean).toLowerCase() === 'false') finalAnswer = false;
          else if (String(q.correctAnswer).toLowerCase() === 'true') finalAnswer = true;
          else if (String(q.correctAnswer).toLowerCase() === 'false') finalAnswer = false;
          // Default
          if (finalAnswer === undefined) finalAnswer = false; // Safe default
        } 
        else if (type === 'RANKING') {
           if (Array.isArray(q.correctAnswerArray)) finalAnswer = q.correctAnswerArray;
           else if (Array.isArray(q.correctAnswer)) finalAnswer = q.correctAnswer;
           else if (Array.isArray(q.answer)) finalAnswer = q.answer;
           
           if (!finalAnswer || finalAnswer.length === 0) {
               // Fallback: If Ranking answer is missing, use options
               console.warn("Missing correct answer for Ranking question", q);
               finalAnswer = q.options || []; 
           }
        }
        else {
           // MULTIPLE_CHOICE
           if (q.correctAnswerString) finalAnswer = q.correctAnswerString;
           else if (q.correctAnswer) finalAnswer = q.correctAnswer;
           else if (q.answer) finalAnswer = q.answer;

           if (!finalAnswer) finalAnswer = "Unknown Answer";
        }

        return {
          id: index,
          type: type as QuestionType,
          text: q.text || "Question text missing",
          options: q.options || [],
          correctAnswer: finalAnswer,
          explanation: q.explanation || "No explanation provided."
        };
      });

      setQuestions(formattedQuestions);
      setCurrentQuestionIndex(0);
      setUserAnswers([]);
      
      if (config.enableSummary && generatedData.keyConcepts?.length > 0) {
        setQuizState('KNOWLEDGE');
      } else {
        setQuizState('PLAYING');
      }

    } catch (err: any) {
      console.error(err);
      setError(err.message || "Failed to generate quiz. Please try again.");
      setQuizState('SETUP');
    }
  };

  // --- Handlers ---

  const handleMaterialUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    setIsProcessingFile(true);
    setError(null);

    try {
      let newText = "";

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const lowerName = file.name.toLowerCase();
        
        if (lowerName.endsWith('.pptx')) {
           newText += await extractTextFromPPTX(file);
        } else if (lowerName.endsWith('.docx')) {
           newText += await extractTextFromDOCX(file);
        } else if (lowerName.endsWith('.txt') || lowerName.endsWith('.md')) {
           newText += `\n[Document: ${file.name}]\n${await file.text()}\n`;
        } else {
             // Try fallback as text for unknown but accepted types in this bucket
             try {
                newText += `\n[File: ${file.name}]\n${await file.text()}\n`;
             } catch(e) {}
        }
      }
      setMaterialText(prev => prev + "\n" + newText);
    } catch (err) {
       console.error(err);
       setError("Error processing material files.");
    } finally {
       setIsProcessingFile(false);
    }
  };

  const handleTranscriptUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) return;

    setIsProcessingFile(true);
    setError(null);

    try {
      let newText = "";

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const lowerName = file.name.toLowerCase();
        
        let rawText = await file.text();
        if (lowerName.endsWith('.vtt')) {
           rawText = cleanVTT(rawText);
        }
        
        newText += `\n[Transcript: ${file.name}]\n${rawText}\n`;
      }
      setTranscriptText(prev => prev + "\n" + newText);
    } catch (err) {
       console.error(err);
       setError("Error processing transcript files.");
    } finally {
       setIsProcessingFile(false);
    }
  };

  const handleCleanTranscript = () => {
    if (!transcriptText) return;
    setTranscriptText(cleanVTT(transcriptText));
  };

  const handleAnswer = (answer: any) => {
    const question = questions[currentQuestionIndex];
    let isCorrect = false;

    if (question.type === 'TRUE_FALSE' || question.type === 'MULTIPLE_CHOICE') {
        // String comparison for robustness
        isCorrect = String(answer).toLowerCase() === String(question.correctAnswer).toLowerCase();
    } else if (question.type === 'RANKING') {
        // Use robust array checking
        const correctArr = question.correctAnswer as string[];
        const userArr = answer as string[];
        isCorrect = isRankingCorrect(correctArr, userArr);
    }

    const newAnswer: UserAnswer = {
        questionId: question.id,
        answer,
        isCorrect
    };

    setUserAnswers(prev => [...prev, newAnswer]);
  };

  const nextQuestion = () => {
    if (currentQuestionIndex < questions.length - 1) {
        setCurrentQuestionIndex(prev => prev + 1);
    } else {
        setQuizState('SUMMARY');
    }
  };

  const resetQuiz = () => {
    setQuizState('SETUP');
    setMaterialText('');
    setTranscriptText('');
    setQuestions([]);
    setQuizSummary([]);
    setUserAnswers([]);
    setCurrentQuestionIndex(0);
  };

  const moveRankItem = (index: number, direction: 'up' | 'down') => {
    if (direction === 'up' && index === 0) return;
    if (direction === 'down' && index === rankingOrder.length - 1) return;
    
    const newOrder = [...rankingOrder];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    [newOrder[index], newOrder[swapIndex]] = [newOrder[swapIndex], newOrder[index]];
    setRankingOrder(newOrder);
  };

  // --- Drag and Drop Handlers ---
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedItemIndex(index);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedItemIndex === null) return;
    if (draggedItemIndex === index) return;
    
    const newOrder = [...rankingOrder];
    const draggedItem = newOrder[draggedItemIndex];
    
    newOrder.splice(draggedItemIndex, 1);
    newOrder.splice(index, 0, draggedItem);
    
    setRankingOrder(newOrder);
    setDraggedItemIndex(index);
  };

  const handleDragEnd = () => {
    setDraggedItemIndex(null);
  };

  const handleExportMistakes = () => {
    const wrongAnswers = userAnswers.filter(ua => !ua.isCorrect);
    
    if (wrongAnswers.length === 0) {
      alert("Great job! You have no mistakes to export.");
      return;
    }

    let mdContent = `# Quiz Mistakes Review\nDate: ${new Date().toLocaleDateString()}\n\n`;

    wrongAnswers.forEach((ua, index) => {
      const q = questions.find(q => q.id === ua.questionId);
      if (!q) return;

      mdContent += `## Question ${index + 1} (${q.type.replace('_', ' ')})\n\n`;
      mdContent += `**Question:** ${q.text}\n\n`;
      
      const formatAns = (val: any) => Array.isArray(val) ? val.join(" → ") : String(val);
      
      mdContent += `**Your Answer:** ${formatAns(ua.answer)}\n`;
      mdContent += `**Correct Answer:** ${formatAns(q.correctAnswer)}\n\n`;
      mdContent += `> **Explanation:** ${q.explanation}\n\n`;
      mdContent += `---\n\n`;
    });

    const blob = new Blob([mdContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'quiz-mistakes.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Common UI ---
  const renderStats = () => (
    <>
      <button 
        onClick={() => setIsStatsOpen(true)}
        className="fixed top-4 right-4 z-50 bg-white/90 backdrop-blur p-2 rounded-full shadow-md hover:shadow-lg border border-gray-200 text-gray-600 transition-all hover:text-blue-600"
        title="Session API Usage"
      >
        <Activity className="w-5 h-5" />
      </button>

      {isStatsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm fade-in">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="bg-gray-900 text-white p-4 flex justify-between items-center">
              <h3 className="font-bold flex items-center gap-2">
                <Activity className="w-5 h-5" /> Session Usage Stats
              </h3>
              <button onClick={() => setIsStatsOpen(false)} className="hover:bg-gray-800 p-1 rounded-full transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 p-3 rounded-xl border border-blue-100">
                  <div className="text-xs text-blue-600 font-bold uppercase tracking-wide">Requests</div>
                  <div className="text-2xl font-bold text-gray-900">{usageStats.requests}</div>
                </div>
                <div className="bg-purple-50 p-3 rounded-xl border border-purple-100">
                  <div className="text-xs text-purple-600 font-bold uppercase tracking-wide">Total Tokens</div>
                  <div className="text-2xl font-bold text-gray-900">
                    {(usageStats.inputTokens + usageStats.outputTokens).toLocaleString()}
                  </div>
                </div>
              </div>
              
              <div className="space-y-2 pt-2">
                 <div className="flex justify-between text-sm text-gray-600">
                    <span>Input Tokens (Prompt)</span>
                    <span className="font-mono font-medium">{usageStats.inputTokens.toLocaleString()}</span>
                 </div>
                 <div className="w-full bg-gray-100 rounded-full h-2">
                    <div className="bg-blue-500 h-2 rounded-full" style={{ width: `${(usageStats.inputTokens / Math.max(1, usageStats.inputTokens + usageStats.outputTokens)) * 100}%` }}></div>
                 </div>
                 
                 <div className="flex justify-between text-sm text-gray-600">
                    <span>Output Tokens (Response)</span>
                    <span className="font-mono font-medium">{usageStats.outputTokens.toLocaleString()}</span>
                 </div>
                 <div className="w-full bg-gray-100 rounded-full h-2">
                    <div className="bg-purple-500 h-2 rounded-full" style={{ width: `${(usageStats.outputTokens / Math.max(1, usageStats.inputTokens + usageStats.outputTokens)) * 100}%` }}></div>
                 </div>
              </div>

              <div className="text-xs text-gray-400 text-center pt-4 border-t border-gray-100">
                Stats reset on page refresh. <br/>
                Check <a href="https://aistudio.google.com/app/plan_information" target="_blank" className="text-blue-600 hover:underline">Google AI Studio</a> for full quota details.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // --- Render Views ---

  if (quizState === 'SETUP') {
    return (
      <>
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in">
          <div className="max-w-6xl w-full bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-8 text-white">
              <div className="flex items-center gap-3 mb-2">
                <Brain className="w-8 h-8" />
                <h1 className="text-3xl font-bold">Gemini Quiz Master</h1>
              </div>
              <p className="opacity-90">Upload lecture content to generate a university-grade quiz.</p>
            </div>

            <div className="p-8 space-y-8">
              {/* Input Section */}
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700">1. Upload Content Sources (Simultaneous)</label>
                
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Left Column: Visual Materials */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                            <FileText className="w-5 h-5 text-blue-600" />
                            <h3 className="font-semibold text-gray-800">Presentation Materials</h3>
                        </div>
                        
                        <div className="relative border-2 border-dashed border-gray-300 rounded-xl p-4 flex flex-col items-center justify-center text-center hover:border-blue-500 transition-colors bg-gray-50 group cursor-pointer h-24">
                            <input 
                            type="file" 
                            multiple 
                            accept=".pptx,.docx,.txt,.md"
                            onChange={handleMaterialUpload}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            />
                            <div className="flex items-center gap-2">
                                <Upload className="w-5 h-5 text-gray-500 group-hover:text-blue-600 transition-colors" />
                                <span className="text-sm font-medium text-gray-600 group-hover:text-blue-600">Upload PPTX, DOCX, TXT</span>
                            </div>
                        </div>

                        <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 flex flex-col h-[500px]">
                            <textarea
                            className="flex-1 bg-transparent border-none resize-none focus:ring-0 text-sm p-2 custom-scrollbar focus:outline-none"
                            placeholder="Or paste slide content / notes here..."
                            value={materialText}
                            onChange={(e) => setMaterialText(e.target.value)}
                            />
                            <div className="text-xs text-gray-400 flex justify-between px-2 pt-2 border-t border-gray-200">
                                <span>{materialText.length} chars</span>
                                {materialText.length > 0 && <CheckCircle className="w-3 h-3 text-green-500" />}
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Verbal Transcript */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                            <div className="flex items-center gap-2">
                                <Mic className="w-5 h-5 text-purple-600" />
                                <h3 className="font-semibold text-gray-800">Verbal Transcript / VTT</h3>
                            </div>
                            {transcriptText.length > 0 && (
                                <button 
                                    onClick={handleCleanTranscript}
                                    className="text-xs flex items-center gap-1 text-purple-600 hover:text-purple-800 hover:bg-purple-50 px-2 py-1 rounded transition-colors"
                                    title="Remove timestamps and headers"
                                >
                                    <Eraser className="w-3 h-3" /> Clean VTT
                                </button>
                            )}
                        </div>

                        <div className="relative border-2 border-dashed border-gray-300 rounded-xl p-4 flex flex-col items-center justify-center text-center hover:border-purple-500 transition-colors bg-gray-50 group cursor-pointer h-24">
                            <input 
                            type="file" 
                            multiple 
                            accept=".vtt,.txt,.md"
                            onChange={handleTranscriptUpload}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            />
                            <div className="flex items-center gap-2">
                                <Upload className="w-5 h-5 text-gray-500 group-hover:text-purple-600 transition-colors" />
                                <span className="text-sm font-medium text-gray-600 group-hover:text-purple-600">Upload VTT, Transcript</span>
                            </div>
                        </div>

                        <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 flex flex-col h-[500px]">
                            <textarea
                            className="flex-1 bg-transparent border-none resize-none focus:ring-0 text-sm p-2 custom-scrollbar focus:outline-none"
                            placeholder="Paste VTT or speech transcript here..."
                            value={transcriptText}
                            onChange={(e) => setTranscriptText(e.target.value)}
                            />
                            <div className="text-xs text-gray-400 flex justify-between px-2 pt-2 border-t border-gray-200">
                                <span>{transcriptText.length} chars</span>
                                {transcriptText.length > 0 && <CheckCircle className="w-3 h-3 text-green-500" />}
                            </div>
                        </div>
                    </div>
                </div>
              </div>

              {/* Config Section */}
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700">2. Configure Quiz</label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <button 
                    onClick={() => setConfig(prev => ({...prev, type: 'MIXED'}))}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${config.type === 'MIXED' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Shuffle className={`w-5 h-5 ${config.type === 'MIXED' ? 'text-blue-600' : 'text-gray-400'}`} />
                      <span className="font-semibold text-sm">Mixed Mode</span>
                    </div>
                    <p className="text-xs text-gray-500">MCQ, T/F, & Ranking</p>
                  </button>
                  
                  <button 
                    onClick={() => setConfig(prev => ({...prev, type: 'MULTIPLE_CHOICE'}))}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${config.type === 'MULTIPLE_CHOICE' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <ListChecks className={`w-5 h-5 ${config.type === 'MULTIPLE_CHOICE' ? 'text-blue-600' : 'text-gray-400'}`} />
                      <span className="font-semibold text-sm">Multiple Choice</span>
                    </div>
                    <p className="text-xs text-gray-500">Standard 4 options</p>
                  </button>

                  <button 
                    onClick={() => setConfig(prev => ({...prev, type: 'TRUE_FALSE'}))}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${config.type === 'TRUE_FALSE' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <ToggleLeft className={`w-5 h-5 ${config.type === 'TRUE_FALSE' ? 'text-blue-600' : 'text-gray-400'}`} />
                      <span className="font-semibold text-sm">True / False</span>
                    </div>
                    <p className="text-xs text-gray-500">Hard Mode & Nuance</p>
                  </button>
                </div>
                
                {/* Question Count Slider */}
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-200">
                  <div className="flex justify-between items-center mb-2">
                    <div className="flex items-center gap-2">
                        <Settings2 className="w-4 h-4 text-gray-500" />
                        <label className="text-sm font-medium text-gray-700">Question Quantity</label>
                    </div>
                    <span className="text-blue-600 font-bold bg-white border border-blue-100 px-3 py-0.5 rounded-lg text-sm shadow-sm">{config.count} Questions</span>
                  </div>
                  <input 
                    type="range" 
                    min="15" 
                    max="50" 
                    step="1"
                    value={config.count}
                    onChange={(e) => setConfig({...config, count: parseInt(e.target.value)})}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600 hover:bg-gray-300 transition-colors"
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-2 px-1 font-medium">
                    <span>15</span>
                    <span>25</span>
                    <span>35</span>
                    <span>50</span>
                  </div>
                </div>

                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-200">
                  <div className="flex items-center gap-3">
                    <Sparkles className="w-5 h-5 text-amber-500" />
                    <div>
                      <span className="block text-sm font-medium text-gray-900">Generate Key Concepts Summary</span>
                      <span className="block text-xs text-gray-500">Get a study guide before the quiz</span>
                    </div>
                  </div>
                  <button 
                    onClick={() => setConfig({...config, enableSummary: !config.enableSummary})}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.enableSummary ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition transition-transform ${config.enableSummary ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              </div>

              {error && (
                <div className="p-4 bg-red-50 text-red-700 rounded-xl flex items-center gap-3 text-sm">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  {error}
                </div>
              )}

              <button
                onClick={generateQuiz}
                disabled={isProcessingFile}
                className="w-full py-4 bg-gray-900 hover:bg-black text-white rounded-xl font-bold text-lg shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isProcessingFile ? (
                  <>
                      <Loader2 className="w-5 h-5 animate-spin" /> Processing Documents...
                  </>
                ) : (
                  <>
                      Generate Quiz <ChevronRight className="w-5 h-5" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (quizState === 'GENERATING') {
    return (
      <>
        {renderStats()}
        <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center fade-in">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-6" />
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Analyzing Content with Gemini 2.5</h2>
          <p className="text-gray-500 max-w-md">Reading slides, notes, and transcripts to extract key insights and challenge your knowledge...</p>
        </div>
      </>
    );
  }

  if (quizState === 'KNOWLEDGE') {
    return (
      <>
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in">
          <div className="max-w-4xl w-full bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                  <div>
                      <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                          <BookOpen className="w-5 h-5 text-blue-600" /> Key Concepts
                      </h2>
                      <p className="text-sm text-gray-500">Review these points before starting the quiz.</p>
                  </div>
                  <button 
                    onClick={() => setQuizState('PLAYING')}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                  >
                    Start Quiz <Play className="w-4 h-4 fill-current" />
                  </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 bg-white custom-scrollbar">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {quizSummary.map((concept, i) => (
                          <div key={i} className="bg-gray-50 rounded-xl p-5 border border-gray-100 hover:shadow-md transition-shadow">
                              <div className="flex items-center gap-3 mb-3 border-b border-gray-200 pb-2">
                                  <span className="text-2xl">{concept.emoji}</span>
                                  <h3 className="font-bold text-gray-800">{concept.title}</h3>
                              </div>
                              <ul className="space-y-2">
                                  {concept.points.map((point, j) => (
                                      <li key={j} className="text-sm text-gray-600 flex items-start gap-2">
                                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                                          <span>{point}</span>
                                      </li>
                                  ))}
                              </ul>
                          </div>
                      ))}
                  </div>
              </div>
          </div>
        </div>
      </>
    );
  }

  if (quizState === 'PLAYING') {
    const question = questions[currentQuestionIndex];
    const isAnswered = userAnswers.some(ua => ua.questionId === question.id);
    const currentAnswer = userAnswers.find(ua => ua.questionId === question.id);

    return (
      <>
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in">
          <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl overflow-hidden">
              {/* Progress Bar */}
              <div className="h-2 bg-gray-100 w-full">
                  <div 
                      className="h-full bg-blue-600 transition-all duration-300" 
                      style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
                  />
              </div>

              <div className="p-8">
                  {/* Header */}
                  <div className="flex justify-between items-center mb-6">
                      <span className="text-xs font-bold tracking-wider text-blue-600 uppercase bg-blue-50 px-3 py-1 rounded-full">
                          {question.type.replace('_', ' ')}
                      </span>
                      <span className="text-sm font-medium text-gray-400">
                          {currentQuestionIndex + 1} / {questions.length}
                      </span>
                  </div>

                  {/* Question */}
                  <h2 className="text-xl md:text-2xl font-bold text-gray-900 mb-8 leading-snug">
                      {question.text}
                  </h2>

                  {/* Options Area */}
                  <div className="space-y-3 mb-8">
                      {question.type === 'TRUE_FALSE' ? (
                          <div className="grid grid-cols-2 gap-4">
                              {[true, false].map((val) => {
                                  const isSelected = currentAnswer?.answer === val;
                                  const isCorrect = question.correctAnswer === val;
                                  
                                  let btnClass = "py-6 rounded-xl border-2 font-semibold text-lg transition-all flex items-center justify-center gap-2 ";
                                  
                                  if (isAnswered) {
                                      if (isCorrect) btnClass += "bg-green-100 border-green-500 text-green-700";
                                      else if (isSelected && !isCorrect) btnClass += "bg-red-50 border-red-300 text-red-600 opacity-50";
                                      else btnClass += "border-gray-100 text-gray-400 opacity-50";
                                  } else {
                                      btnClass += "bg-white border-gray-200 hover:border-blue-500 hover:bg-blue-50 text-gray-700";
                                  }

                                  return (
                                      <button 
                                          key={val.toString()}
                                          disabled={isAnswered}
                                          onClick={() => handleAnswer(val)}
                                          className={btnClass}
                                      >
                                          {val ? "True" : "False"}
                                      </button>
                                  );
                              })}
                          </div>
                      ) : question.type === 'MULTIPLE_CHOICE' ? (
                          <div className="grid grid-cols-1 gap-3">
                              {question.options?.map((opt, i) => {
                                  const isSelected = currentAnswer?.answer === opt;
                                  const isCorrect = question.correctAnswer === opt;
                                  
                                  let btnClass = "w-full p-4 rounded-xl border-2 text-left font-medium transition-all flex items-center justify-between ";

                                  if (isAnswered) {
                                      if (isCorrect) btnClass += "bg-green-50 border-green-500 text-green-800";
                                      else if (isSelected) btnClass += "bg-red-50 border-red-300 text-red-700";
                                      else btnClass += "border-gray-100 text-gray-400 opacity-50";
                                  } else {
                                      btnClass += "bg-white border-gray-200 hover:border-blue-500 hover:bg-blue-50 text-gray-700";
                                  }

                                  return (
                                      <button
                                          key={i}
                                          disabled={isAnswered}
                                          onClick={() => handleAnswer(opt)}
                                          className={btnClass}
                                      >
                                          <span>{opt}</span>
                                          {isAnswered && isCorrect && <CheckCircle className="w-5 h-5 text-green-600" />}
                                          {isAnswered && isSelected && !isCorrect && <XCircle className="w-5 h-5 text-red-500" />}
                                      </button>
                                  );
                              })}
                          </div>
                      ) : (
                          // Ranking Question UI
                          <div className="space-y-4">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="text-sm text-gray-500 italic">
                                    Drag and drop items or use arrows to reorder:
                                </span>
                            </div>
                            
                            <div className="space-y-2">
                                  {(isAnswered ? (currentAnswer?.answer as string[]) : rankingOrder).map((item, i) => (
                                      <div 
                                        key={item} 
                                        draggable={!isAnswered}
                                        onDragStart={(e) => !isAnswered && handleDragStart(e, i)}
                                        onDragOver={(e) => !isAnswered && handleDragOver(e, i)}
                                        onDragEnd={handleDragEnd}
                                        className={`p-3 rounded-xl border-2 flex items-center justify-between transition-all 
                                            ${isAnswered ? 'bg-gray-50 border-gray-200' : 
                                              draggedItemIndex === i ? 'bg-blue-50 border-blue-400 opacity-80 scale-[1.02] shadow-lg z-10' : 'bg-white border-gray-200 hover:border-blue-300 hover:shadow-sm'}
                                            ${!isAnswered ? 'cursor-grab active:cursor-grabbing' : ''}
                                        `}
                                      >
                                          <div className="flex items-center gap-3">
                                              {!isAnswered && (
                                                <div className="text-gray-400 cursor-grab active:cursor-grabbing">
                                                    <GripVertical className="w-5 h-5" />
                                                </div>
                                              )}
                                              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${isAnswered ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-600'}`}>
                                                  {i + 1}
                                              </div>
                                              <span className="font-medium text-gray-700 select-none">{item}</span>
                                          </div>
                                          
                                          {!isAnswered && (
                                              <div className="flex flex-col gap-1">
                                                  <button 
                                                      onClick={() => moveRankItem(i, 'up')}
                                                      disabled={i === 0}
                                                      className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-blue-600 disabled:opacity-30"
                                                      title="Move Up"
                                                  >
                                                      <ArrowUp className="w-4 h-4" />
                                                  </button>
                                                  <button 
                                                      onClick={() => moveRankItem(i, 'down')}
                                                      disabled={i === rankingOrder.length - 1}
                                                      className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-blue-600 disabled:opacity-30"
                                                      title="Move Down"
                                                  >
                                                      <ArrowDown className="w-4 h-4" />
                                                  </button>
                                              </div>
                                          )}
                                      </div>
                                  ))}
                            </div>
                            {!isAnswered && (
                                <button 
                                  onClick={() => handleAnswer(rankingOrder)}
                                  className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors mt-4"
                                >
                                  Confirm Order
                                </button>
                            )}
                            {isAnswered && !currentAnswer?.isCorrect && (
                                <div className="mt-4 p-4 bg-blue-50 rounded-xl border border-blue-100">
                                    <p className="text-xs font-bold text-blue-800 uppercase mb-2">Correct Order vs Your Order:</p>
                                    <div className="grid grid-cols-2 gap-4">
                                      <div>
                                          <div className="text-xs text-red-500 font-semibold mb-1">Your Order</div>
                                          <ol className="list-decimal list-inside space-y-1">
                                            {(currentAnswer?.answer as string[]).map((item, idx) => (
                                                <li key={idx} className="text-xs text-gray-600">{item}</li>
                                            ))}
                                          </ol>
                                      </div>
                                      <div>
                                          <div className="text-xs text-green-600 font-semibold mb-1">Correct Order</div>
                                          <ol className="list-decimal list-inside space-y-1">
                                            {(question.correctAnswer as string[] || []).map((item, idx) => (
                                                <li key={idx} className="text-xs text-gray-800 font-medium">{item}</li>
                                            ))}
                                          </ol>
                                      </div>
                                    </div>
                                </div>
                            )}
                          </div>
                      )}
                  </div>

                  {/* Feedback / Next */}
                  {isAnswered && (
                      <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
                          <div className={`p-4 rounded-xl mb-6 ${currentAnswer?.isCorrect ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                              <div className="flex items-start gap-3">
                                  <Info className={`w-5 h-5 mt-0.5 ${currentAnswer?.isCorrect ? 'text-green-600' : 'text-red-600'}`} />
                                  <div>
                                      <p className={`font-bold text-sm mb-1 ${currentAnswer?.isCorrect ? 'text-green-800' : 'text-red-800'}`}>
                                          {currentAnswer?.isCorrect ? 'Correct!' : 'Incorrect'}
                                      </p>
                                      <p className="text-sm text-gray-700 leading-relaxed">
                                          {question.explanation}
                                      </p>
                                  </div>
                              </div>
                          </div>
                          
                          <button 
                              onClick={nextQuestion}
                              className="w-full py-4 bg-gray-900 text-white rounded-xl font-bold hover:bg-black transition-colors flex items-center justify-center gap-2"
                          >
                              {currentQuestionIndex === questions.length - 1 ? "Finish Quiz" : "Next Question"} <ChevronRight className="w-5 h-5" />
                          </button>
                      </div>
                  )}
              </div>
          </div>
        </div>
      </>
    );
  }

  if (quizState === 'SUMMARY') {
    const score = userAnswers.filter(a => a.isCorrect).length;
    const percentage = Math.round((score / questions.length) * 100);
    const hasMistakes = score < questions.length;

    return (
      <>
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden text-center p-8">
              <div className="mb-6 flex justify-center">
                  <div className="w-24 h-24 rounded-full bg-blue-50 flex items-center justify-center relative">
                      <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
                          <path className="text-blue-100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="3" />
                          <path className="text-blue-600" strokeDasharray={`${percentage}, 100`} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="currentColor" strokeWidth="3" />
                      </svg>
                      <span className="absolute text-2xl font-bold text-blue-600">{percentage}%</span>
                  </div>
              </div>
              
              <h2 className="text-3xl font-bold text-gray-900 mb-2">
                  {percentage >= 80 ? "Excellent!" : percentage >= 50 ? "Good Job!" : "Needs Review"}
              </h2>
              <p className="text-gray-500 mb-8">
                  You scored {score} out of {questions.length} questions correctly.
              </p>

              <div className="space-y-3">
                  <button 
                    onClick={() => setQuizState('REVIEW')}
                    className="w-full py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-xl font-semibold hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2"
                  >
                    <Eye className="w-4 h-4" /> Review Answers
                  </button>

                  {hasMistakes && (
                      <button 
                        onClick={handleExportMistakes}
                        className="w-full py-3 bg-white border-2 border-red-200 text-red-700 rounded-xl font-semibold hover:border-red-400 hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
                      >
                        <Download className="w-4 h-4" /> Export Wrong Questions
                      </button>
                  )}

                  <button 
                    onClick={resetQuiz}
                    className="w-full py-3 bg-gray-900 text-white rounded-xl font-semibold hover:bg-black transition-colors flex items-center justify-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" /> Create New Quiz
                  </button>
              </div>
          </div>
        </div>
      </>
    );
  }

  if (quizState === 'REVIEW') {
      return (
          <>
            {renderStats()}
            <div className="min-h-screen bg-gray-50 p-6 fade-in">
                <div className="max-w-3xl mx-auto space-y-6">
                    {/* Header */}
                    <div className="bg-white rounded-2xl p-6 shadow-sm flex items-center justify-between sticky top-6 z-10">
                        <h2 className="text-xl font-bold text-gray-900">Quiz Review</h2>
                        <button 
                          onClick={() => setQuizState('SUMMARY')}
                          className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                        >
                            <ArrowLeft className="w-4 h-4" /> Back to Summary
                        </button>
                    </div>

                    {/* List */}
                    <div className="space-y-4 pb-12">
                        {questions.map((q, i) => {
                            const userAnswer = userAnswers.find(ua => ua.questionId === q.id);
                            const isCorrect = userAnswer?.isCorrect;

                            // Helper to format answer for display
                            const renderAnswer = (ans: any) => {
                                if (q.type === 'TRUE_FALSE') return ans ? "True" : "False";
                                if (Array.isArray(ans)) {
                                  // For ranking, render a vertical list
                                  return (
                                    <ol className="list-decimal list-inside space-y-1 mt-1">
                                      {ans.map((item: string, idx: number) => (
                                        <li key={idx} className="text-xs">{item}</li>
                                      ))}
                                    </ol>
                                  );
                                }
                                return String(ans);
                            };

                            return (
                                <div key={q.id} className={`bg-white rounded-2xl p-6 shadow-sm border-l-4 ${isCorrect ? 'border-green-500' : 'border-red-500'}`}>
                                    <div className="flex justify-between items-start mb-4">
                                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wide">Question {i + 1}</span>
                                        {isCorrect ? (
                                            <div className="flex items-center gap-1 text-green-600 text-xs font-bold uppercase bg-green-50 px-2 py-1 rounded-full">
                                                <Check className="w-3 h-3" /> Correct
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1 text-red-600 text-xs font-bold uppercase bg-red-50 px-2 py-1 rounded-full">
                                                <X className="w-3 h-3" /> Incorrect
                                            </div>
                                        )}
                                    </div>
                                    
                                    <h3 className="text-lg font-bold text-gray-900 mb-4">{q.text}</h3>
                                    
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 text-sm">
                                        <div className={`p-3 rounded-lg ${isCorrect ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`}>
                                            <span className="block text-xs opacity-70 mb-1 font-semibold uppercase">Your Answer</span>
                                            <div className="font-medium">{userAnswer ? renderAnswer(userAnswer.answer) : "Skipped"}</div>
                                        </div>
                                        {!isCorrect && (
                                            <div className="p-3 rounded-lg bg-blue-50 text-blue-900">
                                                <span className="block text-xs opacity-70 mb-1 font-semibold uppercase">Correct Answer</span>
                                                <div className="font-medium">{renderAnswer(q.correctAnswer)}</div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="bg-gray-50 p-4 rounded-xl">
                                        <div className="flex items-start gap-2">
                                            <Info className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" />
                                            <p className="text-sm text-gray-600 leading-relaxed">{q.explanation}</p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
          </>
      );
  }

  return null;
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);