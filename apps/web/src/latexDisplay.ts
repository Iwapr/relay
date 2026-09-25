import type { Construct, State } from 'micromark-util-types';
import type { Handle } from 'mdast-util-from-markdown';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    latexDisplay: 'latexDisplay';
    latexDisplayMarker: 'latexDisplayMarker';
    latexDisplayData: 'latexDisplayData';
  }
}

// Display math must be recognized before Markdown block constructs, including
// setext headings (=), thematic breaks and blank paragraphs.
export const latexDisplay: Construct = {
  name: 'latexDisplay',
  concrete: true,
  tokenize(effects, ok, nok) {
    const self = this;
    const start: State = (code) => {
      effects.enter('latexDisplay');
      effects.enter('latexDisplayMarker');
      effects.consume(code);
      return opening;
    };
    const opening: State = (code) => {
      if (code !== 91) return nok(code);
      effects.consume(code);
      effects.exit('latexDisplayMarker');
      if (self.interrupt) return ok;
      return content;
    };
    const content: State = (code) => {
      if (code === null || self.parser.lazy[self.now().line]) return nok(code);
      if (code === 92) {
        return effects.attempt(close, ending, data)(code);
      }
      return data(code);
    };
    const data: State = (code) => {
      if (code === null) return nok(code);
      effects.enter('latexDisplayData');
      effects.consume(code);
      // Consume a pair together so \\\\] remains LaTeX content.
      if (code === 92) return escaped;
      effects.exit('latexDisplayData');
      return content;
    };
    const escaped: State = (code) => {
      if (code === null) return nok(code);
      effects.consume(code);
      effects.exit('latexDisplayData');
      return content;
    };
    const ending: State = (code) => {
      if (code === 32 || code === -1 || code === -2) {
        effects.enter('whitespace');
        effects.consume(code);
        effects.exit('whitespace');
        return ending;
      }
      if (code !== null && code !== -5 && code !== -4 && code !== -3) return nok(code);
      effects.exit('latexDisplay');
      return ok(code);
    };
    return start;
  },
};
const close: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    return (code) => {
      effects.enter('latexDisplayMarker');
      effects.consume(code);
      return (next) => {
        if (next !== 93) return nok(next);
        effects.consume(next);
        effects.exit('latexDisplayMarker');
        return ok;
      };
    };
  },
};
export const enterDisplay: Handle = function (token) {
  this.enter({ type: 'math', value: '' }, token);
  this.buffer();
};
export const displayData: Handle = function (token) {
  this.config.enter.data.call(this, token);
  this.config.exit.data.call(this, token);
};
export const exitDisplay: Handle = function (token) {
  const value = this.resume().trim();
  const node = this.stack[this.stack.length - 1];
  if (node.type === 'math') {
    node.value = value;
    node.data = {
      hName: 'pre',
      hChildren: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value }],
        },
      ],
    };
  }
  this.exit(token);
};
