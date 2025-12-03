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

const MODEL_NAME = 'gemini-2.5-flash';

// --- Helper Functions ---

// Robust retry mechanism for Gemini API
const callGeminiWithRetry = async (ai: GoogleGenAI, params: any, retries = 3) => {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await ai.models.generateContent(params);
        } catch (error: any) {
            lastError = error;
            
            // Extract status from various possible error structures (including nested { error: { code: 500 } })
            const status = error.status || error.code || error.statusCode || error?.error?.code || error?.error?.status;
            // Normalize message for checking
            const message = (error.message || error?.error?.message || JSON.stringify(error)).toLowerCase();
            const statusStr = String(status);

            // Retry on server errors (500, 503) or specific network/RPC errors
            const isInternalError = 
                statusStr.includes('500') || 
                statusStr.includes('503') ||
                message.includes('internal server error') ||
                message.includes('rpc failed') ||
                message.includes('xhr error') ||
                message.includes('network error') ||
                message.includes('fetch failed');

            if (isInternalError && i < retries - 1) {
                const delay = Math.pow(2, i) * 1000 + (Math.random() * 1000);
                console.warn(`Gemini API Error (Attempt ${i + 1}/${retries}). Retrying in ${Math.round(delay)}ms...`, error);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
};

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

const extractTextFromPDF = async (file: File): Promise<string> => {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        
        let fullText = `[File: ${file.name}]\n`;
        
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            // textContent.items contains objects with 'str' property
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            if (pageText.trim()) {
                fullText += `[Page ${i}]: ${pageText}\n`;
            }
        }
        return fullText;
    } catch (e) {
        console.error("PDF Parse Error", e);
        return `[Error parsing ${file.name}. Please ensure it is a text-based PDF.]\n`;
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

// Simple Hash for SRS IDs
const generateHash = (str: string) => {
  let hash = 0;
  if (str.length === 0) return '0';
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
  
  // Content State
  const [materialText, setMaterialText] = useState('');
  const [transcriptText, setTranscriptText] = useState('');
  
  // Settings State
  const [config, setConfig] = useState<QuizConfig>({
    type: 'MIXED',
    count: 20,
    enableSummary: true,
    enableTopicFilter: false
  });

  // Topic Selection State
  const [availableTopics, setAvailableTopics] = useState<string[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [isAnalyzingTopics, setIsAnalyzingTopics] = useState(false);

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

  // Stats & Info State
  const [usageStats, setUsageStats] = useState<UsageStats>({ requests: 0, inputTokens: 0, outputTokens: 0 });
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  // SRS State
  const [srsDueCount, setSrsDueCount] = useState(0);

  // Focus management ref
  const mainContainerRef = useRef<HTMLDivElement>(null);

  // --- Effects ---

  // Load SRS stats on mount
  useEffect(() => {
    updateSRSStats();
  }, [quizState]);

  // Initialize ranking order when a ranking question appears
  useEffect(() => {
    if (questions.length > 0 && currentQuestionIndex < questions.length) {
      const currentQ = questions[currentQuestionIndex];
      if (currentQ.type === 'RANKING' && currentQ.options) {
        setRankingOrder([...currentQ.options]);
      }
    }
  }, [currentQuestionIndex, questions]);

  // Focus main container on state change for accessibility
  useEffect(() => {
    if (mainContainerRef.current) {
        mainContainerRef.current.focus();
    }
  }, [quizState]);

  // --- Gemini Logic ---

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
        const fullContent = `=== VISUAL MATERIALS ===\n${materialText}\n=== TRANSCRIPT ===\n${transcriptText}`;
        parts.push({ text: `Analyze the following content and list 8-15 distinct main topics, chapters, or themes covered. Content:\n\n${fullContent}` });

        const schema = {
            type: Type.OBJECT,
            properties: {
                topics: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                    description: "List of topics/chapters found in the content."
                }
            },
            required: ["topics"]
        };

        const response = await callGeminiWithRetry(ai, {
            model: MODEL_NAME,
            contents: { parts },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
                systemInstruction: "You are a content analyzer. Extract high-level topics or chapter titles from the material. Keep topic names concise (under 8 words)."
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

        const data = JSON.parse(response.text || "{}");
        if (data.topics && Array.isArray(data.topics)) {
            setAvailableTopics(data.topics);
            // Default select all
            setSelectedTopics(data.topics);
            setQuizState('TOPIC_SELECTION');
        } else {
            throw new Error("Could not identify topics.");
        }

    } catch (err: any) {
        console.error(err);
        setError("Failed to analyze topics. You can try generating the full quiz without filtering.");
    } finally {
        setIsAnalyzingTopics(false);
    }
  };

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

      let contextPrompt = `Here is the combined content extracted from the user's files:\n\n${fullContent}`;
      
      // Add topic filtering instruction if enabled
      if (config.enableTopicFilter && selectedTopics.length > 0) {
          contextPrompt += `\n\n*** IMPORTANT: SCOPE RESTRICTION ***\nFocus the questions and summary SPECIFICALLY on the following selected topics. Ignore other unrelated content unless necessary for context.\nSELECTED TOPICS: ${selectedTopics.join(', ')}\n`;
      }

      parts.push({ text: contextPrompt });
      
      // Dynamic Prompt Construction
      let taskDescription = "";
      
      const baseProperties = {
        text: { type: Type.STRING, description: "The question text." },
        explanation: { type: Type.STRING, description: "Detailed explanation of the answer." }
      };

      if (config.type === 'TRUE_FALSE') {
        taskDescription = `
          Create exactly ${config.count} "True or False" judgment questions.
          
          *** STYLE GUIDE: ACADEMIC & CLINICAL PRECISION ***
          Generate questions that test specific mechanisms, absolute qualifiers, and classification nuance. Use the following logical patterns:
          
          1. **The "Absolute" Trap**: Use absolute qualifiers ("always", "never", "all", "only") to create statements that are *almost* true but technically false due to exceptions found in the text.
             - Example: "Infection by pathogenic microbes *always* results in disease." -> FALSE (Infection does not always equal disease).
             - Example: "Not *all* parasites are harmful to the host." -> TRUE.
             
          2. **Mechanism Location & Direction**: Swap the specific location or direction of a biological/technical process.
             - Example: "Restriction endonucleases cut DNA at the *ends* of the molecule." -> FALSE (They cut internal phosphodiester bonds; exonucleases cut ends).
             - Example: "Hydrogen ions are pumped *into* the matrix." -> FALSE (They are pumped out to the intermembrane space).
             
          3. **Attribute Misattribution**: Attribute a specific property (like accuracy, speed, or origin) to a related but incorrect subject.
             - Example: "Sanger sequencing has *low accuracy*." -> FALSE (It has high accuracy, but low throughput).
             - Example: "The blue veins in cheese are caused by bacteria." -> FALSE (Caused by a fungus/mold).
             
          4. **Definition Precision**: Define a term using the definition of a *closely related* term.
          
          REQUIREMENTS:
          - Aim for a 50/50 split of True and False answers.
          - The Explanation must explicitly state *why* it is false by correcting the specific error (e.g., "False. Restriction enzymes cut internally; Exonucleases cut at the ends.").
        `;
      } else if (config.type === 'MULTIPLE_CHOICE') {
        taskDescription = `
          Create exactly ${config.count} Multiple Choice Questions (MCQ).
          
          *** ADVANCED DISTRACTOR DESIGN (INTERFERENCE OPTIONS) ***
          You must generate high-quality "distractors" (wrong answers) that discriminate between students who know the material and those who are guessing.
          
          RULES FOR OPTIONS:
          1. **Plausible Logic**: Distractors should be based on common misconceptions, partial truths, or related but incorrect concepts from the text.
          2. **Syntactic Similarity**: All options (correct and incorrect) must be similar in length, grammatical structure, and complexity. Do NOT make the correct answer significantly longer or more detailed than the distractors.
          3. **Term Confusion**: If the content defines term A and term B, create a question about term A where term B is a distractor.
          4. **Avoid Negatives**: Avoid double negatives in options.
          5. **No "All/None of the above"**: These reduce the cognitive load. Do NOT use them.
          
          Structure:
          - Each question must have 4 distinct options.
          - Only ONE option should be correct.
        `;
      } else {
        taskDescription = `
          Create exactly ${config.count} questions using a SMART MIX of types.
          
          DISTRIBUTION RULES:
          1. Mostly Multiple Choice (MCQ) and True/False (T/F).
          2. **RANKING/SORTING Questions**: Include MAX 1-2 ranking questions.
             - ONLY generate a Ranking question if the content involves a clear sequential process, timeline, steps, or hierarchy.
          
          TYPES:
          - TRUE_FALSE: Use "Academic Precision" style. Test for absolute qualifiers ("always", "all") and specific mechanism locations/directions. Correct specific misconceptions (e.g., "Restriction enzymes cut at ends" -> False).
          - MULTIPLE_CHOICE: 4 options. **CRITICAL**: Distractors must be highly plausible.
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

      let finalSchema: any;

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
        // Wrap in object to avoid root array instability
        finalSchema = {
          type: Type.OBJECT,
          properties: {
            questions: {
              type: Type.ARRAY,
              items: questionItemSchema
            }
          },
          required: ["questions"]
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

      const response = await callGeminiWithRetry(ai, {
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

      // Check for 'questions' array primarily, fallback to direct array
      if (generatedData.questions && Array.isArray(generatedData.questions)) {
          parsedQuestions = generatedData.questions;
      } else if (Array.isArray(generatedData)) {
          parsedQuestions = generatedData;
      } else if (!config.enableSummary) {
         // If we don't find questions and it's not a summary mode, something is wrong
         throw new Error("Questions were not generated properly. The model response structure was unexpected.");
      }

      if (config.enableSummary) {
         setQuizSummary(generatedData.keyConcepts || []);
      }

      if (parsedQuestions.length === 0) {
        throw new Error("No questions were generated. Please try again or check your content.");
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

  // --- SRS Handlers ---

  const updateSRSStats = () => {
    try {
        const raw = localStorage.getItem(SRS_STORAGE_KEY);
        if (raw) {
            const data: Record<string, SRSItem> = JSON.parse(raw);
            const now = Date.now();
            const count = Object.values(data).filter(item => item.nextReview <= now).length;
            setSrsDueCount(count);
        } else {
            setSrsDueCount(0);
        }
    } catch (e) { console.error("SRS Load Error", e); }
  };

  const handleSRSUpdate = (question: Question, isCorrect: boolean) => {
    try {
        const raw = localStorage.getItem(SRS_STORAGE_KEY);
        const data: Record<string, SRSItem> = raw ? JSON.parse(raw) : {};
        const id = generateHash(question.text);
        
        const existing = data[id];
        
        // SRS Logic:
        // 1. If it's a new question and correct, do not add to SRS (only track mistakes or existing items).
        // 2. If it's incorrect, add it with interval 0 (immediate review).
        // 3. If it exists and is correct, increase interval.

        if (!existing && isCorrect) return;
        
        const now = Date.now();
        let newItem: SRSItem;

        if (isCorrect) {
            // Leitner-ish increase
            const currentInterval = existing ? existing.interval : 0; 
            // 0 (1st fail) -> 1 day -> 3 days -> 7 days -> 14 days
            let nextInterval = 1;
            if (currentInterval >= 1) nextInterval = 3;
            if (currentInterval >= 3) nextInterval = 7;
            if (currentInterval >= 7) nextInterval = 14;
            if (currentInterval >= 14) nextInterval = 30;
            
            newItem = {
                id,
                question: question, // persist question data
                interval: nextInterval,
                repetition: (existing?.repetition || 0) + 1,
                nextReview: now + (nextInterval * 24 * 60 * 60 * 1000)
            };
        } else {
            // Reset on failure
            newItem = {
                id,
                question: question,
                interval: 0,
                repetition: 0,
                nextReview: now // Due immediately
            };
        }
        
        data[id] = newItem;
        localStorage.setItem(SRS_STORAGE_KEY, JSON.stringify(data));
        updateSRSStats();
    } catch (e) {
        console.error("Failed to save SRS data", e);
    }
  };

  const startReviewSession = () => {
    try {
        const raw = localStorage.getItem(SRS_STORAGE_KEY);
        if (!raw) return;
        const data: Record<string, SRSItem> = JSON.parse(raw);
        const now = Date.now();
        const dueItems = Object.values(data).filter(item => item.nextReview <= now);
        
        if (dueItems.length === 0) {
            alert("No questions due for review right now!");
            return;
        }
        
        // Reconstruct question objects for the quiz runner
        const reviewQuestions = dueItems.map((item, index) => ({
            ...item.question,
            id: index // re-index for this specific session
        }));
        
        // Shuffle them for better review
        for (let i = reviewQuestions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [reviewQuestions[i], reviewQuestions[j]] = [reviewQuestions[j], reviewQuestions[i]];
        }
        
        setQuestions(reviewQuestions);
        setQuizSummary([]); // No summary for review mode
        setCurrentQuestionIndex(0);
        setUserAnswers([]);
        setQuizState('PLAYING');
    } catch (e) {
        console.error("Error starting review", e);
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
        } else if (lowerName.endsWith('.pdf')) {
           newText += await extractTextFromPDF(file);
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
       setError("Error processing material files. Note: Scanned PDFs (images) are not supported yet.");
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

    // Save to SRS
    handleSRSUpdate(question, isCorrect);

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
    updateSRSStats();
    setQuizState('SETUP');
    setMaterialText('');
    setTranscriptText('');
    setQuestions([]);
    setQuizSummary([]);
    setUserAnswers([]);
    setCurrentQuestionIndex(0);
    setAvailableTopics([]);
    setSelectedTopics([]);
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

  const toggleTopicSelection = (topic: string) => {
      setSelectedTopics(prev => {
          if (prev.includes(topic)) {
              return prev.filter(t => t !== topic);
          } else {
              return [...prev, topic];
          }
      });
  };

  // --- Common UI ---

  const renderInfoModal = () => (
    <>
      <button
        onClick={() => setIsInfoOpen(true)}
        className="fixed top-4 right-16 z-50 bg-white/90 backdrop-blur p-2 rounded-full shadow-md hover:shadow-lg border border-gray-200 text-gray-600 transition-all hover:text-blue-600"
        title="About & How it Works"
        aria-label="About this app"
      >
        <CircleHelp className="w-5 h-5" aria-hidden="true" />
      </button>

      {isInfoOpen && (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="info-title"
        >
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="bg-gray-900 text-white p-4 flex justify-between items-center flex-shrink-0">
              <h3 id="info-title" className="font-bold flex items-center gap-2">
                <Brain className="w-5 h-5" aria-hidden="true" /> About Gemini Quiz Master
              </h3>
              <button
                onClick={() => setIsInfoOpen(false)}
                className="hover:bg-gray-800 p-1 rounded-full transition-colors"
                aria-label="Close info modal"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto custom-scrollbar">
                <div className="space-y-6">
                    <section>
                        <h4 className="text-lg font-bold text-gray-900 mb-2 flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-amber-500" /> How it Works
                        </h4>
                        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-600">
                            <li><strong>Upload Materials:</strong> Drop your lecture slides (PPTX), notes (DOCX/PDF), or transcripts (VTT).</li>
                            <li><strong>AI Analysis:</strong> The app sends the text to Google's <strong>Gemini 2.5 Flash</strong> model.</li>
                            <li><strong>Generation:</strong> The AI extracts key concepts and creates challenging questions designed to test deep understanding, using techniques like concept swapping and specific distractor generation.</li>
                            <li><strong>Review:</strong> Take the quiz, get instant feedback, and review a summary of key concepts.</li>
                        </ol>
                    </section>
                    
                     <section>
                        <h4 className="text-lg font-bold text-gray-900 mb-2 flex items-center gap-2">
                            <History className="w-4 h-4 text-purple-500" /> Spaced Repetition (New)
                        </h4>
                        <p className="text-sm text-gray-600">
                            The app automatically saves questions you answer incorrectly. These will reappear in the "Review Dashboard" at optimal intervals (1 day, 3 days, 1 week, etc.) to help you master difficult concepts.
                        </p>
                    </section>

                    <section>
                        <h4 className="text-lg font-bold text-gray-900 mb-2 flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-red-500" /> Limitations
                        </h4>
                        <ul className="list-disc list-inside space-y-2 text-sm text-gray-600">
                            <li><strong>Text Only:</strong> The app currently processes text-based files. It cannot "see" images or diagrams inside your slides or scanned PDFs yet.</li>
                            <li><strong>AI Accuracy:</strong> While Gemini is powerful, it can occasionally "hallucinate" or misinterpret specific context. Always verify with your source material.</li>
                            <li><strong>File Size:</strong> Extremely large files might hit browser memory limits or API token limits.</li>
                        </ul>
                    </section>

                    <section>
                        <h4 className="text-lg font-bold text-gray-900 mb-2">Technicals</h4>
                        <p className="text-sm text-gray-600">
                            Powered by <strong>Google Gemini API</strong> (Gemini 2.5 Flash). Files are processed locally in your browser to extract text, then that text is sent securely to the API for processing. Your files are not stored on our servers.
                        </p>
                    </section>
                </div>
            </div>
            
            <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-end flex-shrink-0">
                <button 
                    onClick={() => setIsInfoOpen(false)}
                    className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-black transition-colors"
                >
                    Got it
                </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  const renderStats = () => (
    <>
      <button 
        onClick={() => setIsStatsOpen(true)}
        className="fixed top-4 right-4 z-50 bg-white/90 backdrop-blur p-2 rounded-full shadow-md hover:shadow-lg border border-gray-200 text-gray-600 transition-all hover:text-blue-600"
        title="Session API Usage"
        aria-label="Session API Usage Stats"
      >
        <Activity className="w-5 h-5" aria-hidden="true" />
      </button>

      {isStatsOpen && (
        <div 
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm fade-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stats-title"
        >
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="bg-gray-900 text-white p-4 flex justify-between items-center">
              <h3 id="stats-title" className="font-bold flex items-center gap-2">
                <Activity className="w-5 h-5" aria-hidden="true" /> Session Usage Stats
              </h3>
              <button 
                onClick={() => setIsStatsOpen(false)} 
                className="hover:bg-gray-800 p-1 rounded-full transition-colors"
                aria-label="Close stats"
              >
                <X className="w-5 h-5" aria-hidden="true" />
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
        {renderInfoModal()}
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
          <div className="max-w-6xl w-full bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-8 text-white">
              <div className="flex items-center gap-3 mb-2">
                <Brain className="w-8 h-8" aria-hidden="true" />
                <h1 className="text-3xl font-bold">Gemini Quiz Master</h1>
              </div>
              <p className="opacity-90">Upload lecture content to generate a university-grade quiz.</p>
            </div>

            <div className="p-8 space-y-8">
              
              {/* SRS Section - Only show if items are due */}
              {srsDueCount > 0 && (
                  <div className="bg-purple-50 border border-purple-200 rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4">
                      <div className="flex items-center gap-4">
                          <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center text-purple-600">
                              <History className="w-6 h-6" />
                          </div>
                          <div>
                              <h3 className="text-lg font-bold text-gray-900">Review Due</h3>
                              <p className="text-gray-600 text-sm">You have <span className="font-bold text-purple-700">{srsDueCount} questions</span> from previous sessions ready for review.</p>
                          </div>
                      </div>
                      <button 
                        onClick={startReviewSession}
                        className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl shadow-md transition-all flex items-center gap-2"
                      >
                          <Clock className="w-4 h-4" /> Start Review Session
                      </button>
                  </div>
              )}

              {/* Input Section */}
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700">1. Upload Content Sources (Simultaneous)</label>
                
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Left Column: Visual Materials */}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 pb-2 border-b border-gray-100">
                            <FileText className="w-5 h-5 text-blue-600" aria-hidden="true" />
                            <h3 className="font-semibold text-gray-800">Presentation Materials</h3>
                        </div>
                        
                        <div className="relative border-2 border-dashed border-gray-300 rounded-xl p-4 flex flex-col items-center justify-center text-center hover:border-blue-500 transition-colors bg-gray-50 group cursor-pointer h-24 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2">
                            <input 
                                type="file" 
                                multiple 
                                accept=".pptx,.docx,.pdf,.txt,.md"
                                onChange={handleMaterialUpload}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                aria-label="Upload Presentation Materials (PPTX, DOCX, PDF, TXT)"
                            />
                            <div className="flex items-center gap-2">
                                <Upload className="w-5 h-5 text-gray-500 group-hover:text-blue-600 transition-colors" aria-hidden="true" />
                                <span className="text-sm font-medium text-gray-600 group-hover:text-blue-600">Upload PPTX, PDF, DOCX, TXT</span>
                            </div>
                        </div>

                        <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 flex flex-col h-[500px]">
                            <textarea
                                className="flex-1 bg-transparent border-none resize-none focus:ring-0 text-sm p-2 custom-scrollbar focus:outline-none"
                                placeholder="Or paste slide content / notes here..."
                                value={materialText}
                                onChange={(e) => setMaterialText(e.target.value)}
                                aria-label="Paste presentation text content"
                            />
                            <div className="text-xs text-gray-400 flex justify-between px-2 pt-2 border-t border-gray-200">
                                <span>{materialText.length} chars</span>
                                {materialText.length > 0 && <CircleCheck className="w-3 h-3 text-green-500" aria-hidden="true" />}
                            </div>
                        </div>
                    </div>

                    {/* Right Column: Verbal Transcript */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between pb-2 border-b border-gray-100">
                            <div className="flex items-center gap-2">
                                <Mic className="w-5 h-5 text-purple-600" aria-hidden="true" />
                                <h3 className="font-semibold text-gray-800">Verbal Transcript / VTT</h3>
                            </div>
                            {transcriptText.length > 0 && (
                                <button 
                                    onClick={handleCleanTranscript}
                                    className="text-xs flex items-center gap-1 text-purple-600 hover:text-purple-800 hover:bg-purple-50 px-2 py-1 rounded transition-colors"
                                    title="Remove timestamps and headers"
                                    aria-label="Clean VTT Timestamps"
                                >
                                    <Eraser className="w-3 h-3" aria-hidden="true" /> Clean VTT
                                </button>
                            )}
                        </div>

                        <div className="relative border-2 border-dashed border-gray-300 rounded-xl p-4 flex flex-col items-center justify-center text-center hover:border-purple-500 transition-colors bg-gray-50 group cursor-pointer h-24 focus-within:ring-2 focus-within:ring-purple-500 focus-within:ring-offset-2">
                            <input 
                                type="file" 
                                multiple 
                                accept=".vtt,.txt,.md"
                                onChange={handleTranscriptUpload}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                aria-label="Upload Transcript Files (VTT, TXT)"
                            />
                            <div className="flex items-center gap-2">
                                <Upload className="w-5 h-5 text-gray-500 group-hover:text-purple-600 transition-colors" aria-hidden="true" />
                                <span className="text-sm font-medium text-gray-600 group-hover:text-purple-600">Upload VTT, Transcript</span>
                            </div>
                        </div>

                        <div className="border border-gray-200 rounded-xl p-3 bg-gray-50 flex flex-col h-[500px]">
                            <textarea
                                className="flex-1 bg-transparent border-none resize-none focus:ring-0 text-sm p-2 custom-scrollbar focus:outline-none"
                                placeholder="Paste VTT or speech transcript here..."
                                value={transcriptText}
                                onChange={(e) => setTranscriptText(e.target.value)}
                                aria-label="Paste transcript text content"
                            />
                            <div className="text-xs text-gray-400 flex justify-between px-2 pt-2 border-t border-gray-200">
                                <span>{transcriptText.length} chars</span>
                                {transcriptText.length > 0 && <CircleCheck className="w-3 h-3 text-green-500" aria-hidden="true" />}
                            </div>
                        </div>
                    </div>
                </div>
              </div>

              {/* Config Section */}
              <div className="space-y-4">
                <label className="block text-sm font-medium text-gray-700" id="quiz-type-label">2. Configure Quiz</label>
                <div 
                    className="grid grid-cols-1 md:grid-cols-3 gap-4" 
                    role="radiogroup" 
                    aria-labelledby="quiz-type-label"
                >
                  <button 
                    onClick={() => setConfig(prev => ({...prev, type: 'MIXED'}))}
                    className={`p-4 rounded-xl border-2 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${config.type === 'MIXED' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                    role="radio"
                    aria-checked={config.type === 'MIXED'}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Shuffle className={`w-5 h-5 ${config.type === 'MIXED' ? 'text-blue-600' : 'text-gray-400'}`} aria-hidden="true" />
                      <span className="font-semibold text-sm">Mixed Mode</span>
                    </div>
                    <p className="text-xs text-gray-500">MCQ, T/F, & Ranking</p>
                  </button>
                  
                  <button 
                    onClick={() => setConfig(prev => ({...prev, type: 'MULTIPLE_CHOICE'}))}
                    className={`p-4 rounded-xl border-2 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${config.type === 'MULTIPLE_CHOICE' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                    role="radio"
                    aria-checked={config.type === 'MULTIPLE_CHOICE'}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <ListChecks className={`w-5 h-5 ${config.type === 'MULTIPLE_CHOICE' ? 'text-blue-600' : 'text-gray-400'}`} aria-hidden="true" />
                      <span className="font-semibold text-sm">Multiple Choice</span>
                    </div>
                    <p className="text-xs text-gray-500">Standard 4 options</p>
                  </button>

                  <button 
                    onClick={() => setConfig(prev => ({...prev, type: 'TRUE_FALSE'}))}
                    className={`p-4 rounded-xl border-2 text-left transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${config.type === 'TRUE_FALSE' ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500' : 'border-gray-200 hover:border-gray-300'}`}
                    role="radio"
                    aria-checked={config.type === 'TRUE_FALSE'}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <ToggleLeft className={`w-5 h-5 ${config.type === 'TRUE_FALSE' ? 'text-blue-600' : 'text-gray-400'}`} aria-hidden="true" />
                      <span className="font-semibold text-sm">True / False</span>
                    </div>
                    <p className="text-xs text-gray-500">Academic Precision</p>
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-200">
                    <div className="flex items-center gap-3">
                      <Sparkles className="w-5 h-5 text-amber-500" aria-hidden="true" />
                      <div>
                        <span className="block text-sm font-medium text-gray-900" id="summary-label">Generate Summary</span>
                        <span className="block text-xs text-gray-500">Key concepts study guide</span>
                      </div>
                    </div>
                    <button 
                      onClick={() => setConfig({...config, enableSummary: !config.enableSummary})}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500 ${config.enableSummary ? 'bg-blue-600' : 'bg-gray-200'}`}
                      role="switch"
                      aria-checked={config.enableSummary}
                      aria-labelledby="summary-label"
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition transition-transform ${config.enableSummary ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-200">
                    <div className="flex items-center gap-3">
                      <Target className="w-5 h-5 text-indigo-500" aria-hidden="true" />
                      <div>
                        <span className="block text-sm font-medium text-gray-900" id="topic-filter-label">Filter by Topic</span>
                        <span className="block text-xs text-gray-500">Select specific chapters</span>
                      </div>
                    </div>
                    <button 
                      onClick={() => setConfig({...config, enableTopicFilter: !config.enableTopicFilter})}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 ${config.enableTopicFilter ? 'bg-indigo-600' : 'bg-gray-200'}`}
                      role="switch"
                      aria-checked={config.enableTopicFilter}
                      aria-labelledby="topic-filter-label"
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition transition-transform ${config.enableTopicFilter ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>
              </div>

              {error && (
                <div className="p-4 bg-red-50 text-red-700 rounded-xl flex items-center gap-3 text-sm" role="alert">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                  {error}
                </div>
              )}

              <button
                onClick={config.enableTopicFilter ? extractTopics : generateQuiz}
                disabled={isProcessingFile || isAnalyzingTopics}
                className={`w-full py-4 text-white rounded-xl font-bold text-lg shadow-lg hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 focus:outline-none focus:ring-4 ${config.enableTopicFilter ? 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-400' : 'bg-gray-900 hover:bg-black focus:ring-gray-400'}`}
              >
                {isProcessingFile || isAnalyzingTopics ? (
                  <>
                      <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> {isAnalyzingTopics ? "Scanning Topics..." : "Processing Documents..."}
                  </>
                ) : (
                  <>
                      {config.enableTopicFilter ? "Scan Content for Topics" : "Generate Quiz"} <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (quizState === 'TOPIC_SELECTION') {
      return (
        <>
            {renderInfoModal()}
            {renderStats()}
            <div className="min-h-screen flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
                <div className="max-w-4xl w-full bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
                    <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-white sticky top-0 z-10">
                        <div>
                            <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                                <Filter className="w-5 h-5 text-indigo-600" aria-hidden="true" /> Select Topics
                            </h2>
                            <p className="text-sm text-gray-500">Choose which areas to focus the quiz on.</p>
                        </div>
                        <div className="flex gap-2">
                            <button 
                                onClick={() => setSelectedTopics(availableTopics)}
                                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                            >
                                Select All
                            </button>
                            <button 
                                onClick={() => setSelectedTopics([])}
                                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                            >
                                Clear
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-6 bg-gray-50 custom-scrollbar">
                         {availableTopics.length === 0 ? (
                             <div className="text-center py-12 text-gray-500">
                                 <AlertCircle className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                 No distinct topics found. Please try generating the full quiz.
                             </div>
                         ) : (
                             <div className="grid grid-cols-1 md:grid-cols-2 gap-3" role="group" aria-label="Topics found in content">
                                 {availableTopics.map((topic, i) => {
                                     const isSelected = selectedTopics.includes(topic);
                                     return (
                                         <button
                                             key={i}
                                             onClick={() => toggleTopicSelection(topic)}
                                             className={`p-4 rounded-xl border-2 text-left transition-all flex items-start gap-3 focus:outline-none focus:ring-2 focus:ring-offset-1 ${isSelected ? 'bg-indigo-50 border-indigo-500 shadow-sm focus:ring-indigo-500' : 'bg-white border-gray-200 hover:border-gray-300 text-gray-600 focus:ring-gray-400'}`}
                                             role="checkbox"
                                             aria-checked={isSelected}
                                         >
                                             <div className={`mt-0.5 w-5 h-5 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-gray-300'}`}>
                                                 {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                                             </div>
                                             <span className={`font-medium ${isSelected ? 'text-indigo-900' : 'text-gray-700'}`}>{topic}</span>
                                         </button>
                                     );
                                 })}
                             </div>
                         )}
                    </div>

                    <div className="p-4 border-t border-gray-100 bg-white flex justify-between items-center flex-shrink-0">
                        <button 
                            onClick={() => setQuizState('SETUP')}
                            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg font-medium transition-colors flex items-center gap-2"
                        >
                            <ArrowLeft className="w-4 h-4" /> Back
                        </button>
                        <button 
                            onClick={generateQuiz}
                            disabled={selectedTopics.length === 0}
                            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold transition-colors flex items-center gap-2 shadow-lg shadow-indigo-200"
                        >
                            Generate Quiz ({selectedTopics.length}) <Play className="w-4 h-4 fill-current" />
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
        {renderInfoModal()}
        {renderStats()}
        <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center fade-in" role="status" aria-live="polite">
          <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-6" aria-hidden="true" />
          <h2 className="text-2xl font-bold text-gray-800 mb-2">Analyzing Content with Gemini 2.5</h2>
          <p className="text-gray-500 max-w-md">Reading slides, notes, and transcripts to extract key insights and challenge your knowledge...</p>
        </div>
      </>
    );
  }

  if (quizState === 'KNOWLEDGE') {
    return (
      <>
        {renderInfoModal()}
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
          <div className="max-w-4xl w-full bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
              <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50">
                  <div>
                      <h2 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                          <BookOpen className="w-5 h-5 text-blue-600" aria-hidden="true" /> Key Concepts
                      </h2>
                      <p className="text-sm text-gray-500">Review these points before starting the quiz.</p>
                  </div>
                  <button 
                    onClick={() => setQuizState('PLAYING')}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  >
                    Start Quiz <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                  </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 bg-white custom-scrollbar">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {quizSummary.map((concept, i) => (
                          <div key={i} className="bg-gray-50 rounded-xl p-5 border border-gray-100 hover:shadow-md transition-shadow">
                              <div className="flex items-center gap-3 mb-3 border-b border-gray-200 pb-2">
                                  <span className="text-2xl" role="img" aria-label="concept icon">{concept.emoji}</span>
                                  <h3 className="font-bold text-gray-800">{concept.title}</h3>
                              </div>
                              <ul className="space-y-2">
                                  {concept.points.map((point, j) => (
                                      <li key={j} className="text-sm text-gray-600 flex items-start gap-2">
                                          <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" aria-hidden="true" />
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
        {renderInfoModal()}
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
          <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl overflow-hidden">
              {/* Progress Bar */}
              <div className="h-2 bg-gray-100 w-full" role="progressbar" aria-valuenow={currentQuestionIndex + 1} aria-valuemin={1} aria-valuemax={questions.length}>
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
                      <span className="text-sm font-medium text-gray-400" aria-label={`Question ${currentQuestionIndex + 1} of ${questions.length}`}>
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
                                  
                                  let btnClass = "py-6 rounded-xl border-2 font-semibold text-lg transition-all flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ";
                                  
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
                                          aria-pressed={isSelected}
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
                                  
                                  let btnClass = "w-full p-4 rounded-xl border-2 text-left font-medium transition-all flex items-center justify-between focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ";

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
                                          aria-pressed={isSelected}
                                      >
                                          <span>{opt}</span>
                                          {isAnswered && isCorrect && <CircleCheck className="w-5 h-5 text-green-600" aria-hidden="true" />}
                                          {isAnswered && isSelected && !isCorrect && <CircleX className="w-5 h-5 text-red-500" aria-hidden="true" />}
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
                            
                            <ul className="space-y-2" aria-label="Ranking Options. Use arrow buttons to reorder.">
                                  {(isAnswered ? (currentAnswer?.answer as string[]) : rankingOrder).map((item, i) => (
                                      <li 
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
                                                <div className="text-gray-400 cursor-grab active:cursor-grabbing" aria-hidden="true">
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
                                                      className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-blue-600 disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                      title="Move Up"
                                                      aria-label={`Move ${item} up`}
                                                  >
                                                      <ArrowUp className="w-4 h-4" aria-hidden="true" />
                                                  </button>
                                                  <button 
                                                      onClick={() => moveRankItem(i, 'down')}
                                                      disabled={i === rankingOrder.length - 1}
                                                      className="p-1 hover:bg-gray-100 rounded text-gray-400 hover:text-blue-600 disabled:opacity-30 focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                      title="Move Down"
                                                      aria-label={`Move ${item} down`}
                                                  >
                                                      <ArrowDown className="w-4 h-4" aria-hidden="true" />
                                                  </button>
                                              </div>
                                          )}
                                      </li>
                                  ))}
                            </ul>
                            {!isAnswered && (
                                <button 
                                  onClick={() => handleAnswer(rankingOrder)}
                                  className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors mt-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                                >
                                  Confirm Order
                                </button>
                            )}
                            {isAnswered && !currentAnswer?.isCorrect && (
                                <div className="mt-4 p-4 bg-blue-50 rounded-xl border border-blue-100" role="status">
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
                      <div className="animate-in fade-in slide-in-from-bottom-4 duration-300" role="alert">
                          <div className={`p-4 rounded-xl mb-6 ${currentAnswer?.isCorrect ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                              <div className="flex items-start gap-3">
                                  <Info className={`w-5 h-5 mt-0.5 ${currentAnswer?.isCorrect ? 'text-green-600' : 'text-red-600'}`} aria-hidden="true" />
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
                              className="w-full py-4 bg-gray-900 text-white rounded-xl font-bold hover:bg-black transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-4 focus:ring-gray-400"
                          >
                              {currentQuestionIndex === questions.length - 1 ? "Finish Quiz" : "Next Question"} <ChevronRight className="w-5 h-5" aria-hidden="true" />
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
        {renderInfoModal()}
        {renderStats()}
        <div className="min-h-screen flex items-center justify-center p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
          <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden text-center p-8">
              <div className="mb-6 flex justify-center">
                  <div className="w-24 h-24 rounded-full bg-blue-50 flex items-center justify-center relative">
                      <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
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
                    className="w-full py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-xl font-semibold hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  >
                    <Eye className="w-4 h-4" aria-hidden="true" /> Review Answers
                  </button>

                  {hasMistakes && (
                      <button 
                        onClick={handleExportMistakes}
                        className="w-full py-3 bg-white border-2 border-red-200 text-red-700 rounded-xl font-semibold hover:border-red-400 hover:bg-red-50 transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
                      >
                        <Download className="w-4 h-4" aria-hidden="true" /> Export Wrong Questions
                      </button>
                  )}

                  <button 
                    onClick={resetQuiz}
                    className="w-full py-3 bg-gray-900 text-white rounded-xl font-semibold hover:bg-black transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-4 focus:ring-gray-400"
                  >
                    <RefreshCw className="w-4 h-4" aria-hidden="true" /> Create New Quiz
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
            {renderInfoModal()}
            {renderStats()}
            <div className="min-h-screen bg-gray-50 p-6 fade-in" ref={mainContainerRef} tabIndex={-1}>
                <div className="max-w-3xl mx-auto space-y-6">
                    {/* Header */}
                    <div className="bg-white rounded-2xl p-6 shadow-sm flex items-center justify-between sticky top-6 z-10">
                        <h2 className="text-xl font-bold text-gray-900">Quiz Review</h2>
                        <button 
                          onClick={() => setQuizState('SUMMARY')}
                          className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-gray-400"
                        >
                            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to Summary
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
                                                <Check className="w-3 h-3" aria-hidden="true" /> Correct
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-1 text-red-600 text-xs font-bold uppercase bg-red-50 px-2 py-1 rounded-full">
                                                <X className="w-3 h-3" aria-hidden="true" /> Incorrect
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
                                            <Info className="w-4 h-4 text-gray-400 mt-0.5 flex-shrink-0" aria-hidden="true" />
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