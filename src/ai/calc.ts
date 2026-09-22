class ExpressionParser {
  private index = 0;
  private readonly input: string;

  constructor(input: string) { this.input = input; }

  parse(): number {
    const value = this.parseExpression();
    this.skipSpaces();
    if (this.index !== this.input.length) throw new Error('存在未识别字符');
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      this.skipSpaces();
      const op = this.input[this.index];
      if (op !== '+' && op !== '-') return value;
      this.index++;
      const right = this.parseTerm();
      value = op === '+' ? value + right : value - right;
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    while (true) {
      this.skipSpaces();
      const op = this.input[this.index];
      if (op !== '*' && op !== '/') return value;
      this.index++;
      const right = this.parseUnary();
      if (op === '/' && right === 0) throw new Error('除数不能为 0');
      value = op === '*' ? value * right : value / right;
    }
  }

  private parseUnary(): number {
    this.skipSpaces();
    const op = this.input[this.index];
    if (op === '+' || op === '-') {
      this.index++;
      const value = this.parseUnary();
      return op === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipSpaces();
    if (this.input[this.index] === '(') {
      this.index++;
      const value = this.parseExpression();
      this.skipSpaces();
      if (this.input[this.index] !== ')') throw new Error('括号不匹配');
      this.index++;
      return this.parsePercent(value);
    }
    const start = this.index;
    let dots = 0;
    while (this.index < this.input.length && /[0-9.]/.test(this.input[this.index])) {
      if (this.input[this.index] === '.') dots++;
      this.index++;
    }
    if (start === this.index || dots > 1) throw new Error('数字格式不合法');
    const value = Number(this.input.slice(start, this.index));
    if (!Number.isFinite(value)) throw new Error('数字不合法');
    return this.parsePercent(value);
  }

  private parsePercent(value: number): number {
    this.skipSpaces();
    if (this.input[this.index] === '%') {
      this.index++;
      return value / 100;
    }
    return value;
  }

  private skipSpaces() {
    while (/\s/.test(this.input[this.index] || '')) this.index++;
  }
}

export function evaluateExpression(expression: string): number {
  const input = String(expression || '').trim();
  if (!input || input.length > 200 || !/^[0-9+\-*/().%\s]+$/.test(input)) throw new Error('只支持数字和 + - * / ( ) . %');
  const value = new ExpressionParser(input).parse();
  if (!Number.isFinite(value)) throw new Error('结果不是有限数字');
  return Math.round(value * 10000) / 10000;
}
