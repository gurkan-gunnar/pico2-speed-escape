// Pure parsing/state functions are kept separate so they can be tested without a browser.
export function parseProgress(text) {
  const clean = String(text).toUpperCase().replace(/\s+/g, ' ');
  // OCR sometimes loses part of "Question" but still reads the 4/5 fraction.
  const match = clean.match(/(?:QUEST(?:I|1|L)?ON\s*)?([1-5])\s*[/|I1]\s*[5S]/);
  return match ? Number(match[1]) : null;
}

export function parseEquation(text) {
  const clean = String(text).toUpperCase().replace(/[×✕*]/g, 'X');
  const match = clean.match(/(?:^|\D)(1[0-2]|[1-9])\s*X\s*(1[0-2]|[1-9])\s*(?:=|\?)/);
  if (!match) return null;
  return { a: Number(match[1]), b: Number(match[2]) };
}

export class QuizGuard {
  constructor() {
    this.candidate = '';
    this.matches = 0;
    this.sent = new Set();
    this.lastQuestion = 0;
    this.absentSince = 0;
    this.readyForNextQuiz = false;
  }

  observe(result, now, modalVisible = false) {
    if (!result) {
      this.candidate = '';
      this.matches = 0;
      if (modalVisible) {
        this.absentSince = 0;
        return null;
      }
      if (!this.absentSince) this.absentSince = now;
      if (this.lastQuestion === 5 && now - this.absentSince > 3000) {
        this.readyForNextQuiz = true;
      }
      return null;
    }
    this.absentSince = 0;
    const { question, a, b } = result;
    const key = `${question}:${a}x${b}`;
    if (this.readyForNextQuiz && question === 1) {
      this.sent.clear();
      this.lastQuestion = 0;
      this.readyForNextQuiz = false;
    }
    if (this.sent.has(key)) return null;
    if (this.lastQuestion && question < this.lastQuestion) return null;
    if (this.lastQuestion && question > this.lastQuestion + 1) return null;
    if (key === this.candidate) this.matches += 1;
    else {
      this.candidate = key;
      this.matches = 1;
    }
    return this.matches >= 2 ? { key, question, a, b } : null;
  }

  markSent(candidate) {
    this.sent.add(candidate.key);
    this.lastQuestion = candidate.question;
    this.candidate = '';
    this.matches = 0;
  }
}
