import { latexDisplay, enterDisplay, exitDisplay, displayData } from './latexDisplay';
import type { Processor } from 'unified';
import type {} from 'remark-parse';
import type {} from 'mdast-util-math';
import type { Construct, State } from 'micromark-util-types';
import type { Handle } from 'mdast-util-from-markdown';

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    latexMath: 'latexMath';
    latexMathMarker: 'latexMathMarker';
    latexMathData: 'latexMathData';
  }
}

// Parse at the Markdown syntax layer so code, escaped backslashes, link
// destinations and dollar-delimited math keep their original meaning.
const latexMath: Construct = {
  name: 'latexMath',
  tokenize(effects, ok, nok) {
    let closing: number;
    const start: State = (code) => {
      effects.enter('latexMath');
      effects.enter('latexMathMarker');
      effects.consume(code);
      return opening;
    };
    const opening: State = (code) => {
      if (code !== 40 && code !== 91) return nok(code);
      closing = code === 40 ? 41 : 93;
      effects.consume(code);
      effects.exit('latexMathMarker');
      return content;
    };
    const content: State = (code) => {
      if (code === null) return nok(code);
      if (code === -5 || code === -4 || code === -3) {
        effects.enter('lineEnding');
        effects.consume(code);
        effects.exit('lineEnding');
        return content;
      }
      if (code === 92) {
        effects.enter('latexMathMarker');
        effects.consume(code);
        return backslash;
      }
      effects.enter('latexMathData');
      return data(code);
    };
    const data: State = (code) => {
      if (code === null || code === 92 || code === -5 || code === -4 || code === -3) {
        effects.exit('latexMathData');
        return content(code);
      }
      effects.consume(code);
      return data;
    };
    const backslash: State = (code) => {
      if (code === closing) {
        effects.consume(code);
        effects.exit('latexMathMarker');
        effects.exit('latexMath');
        return ok;
      }
      if (code === 92) {
        effects.consume(code);
        effects.exit('latexMathMarker');
        return content;
      }
      effects.exit('latexMathMarker');
      return content(code);
    };
    return start;
  },
};

const enter: Handle = function (token) {
  const source = this.sliceSerialize(token);
  const value = source.slice(2, -2);
  this.enter(
    {
      type: 'inlineMath',
      value,
      data: {
        hName: 'code',
        hProperties: { className: ['language-math', source[1] === '[' ? 'math-display' : 'math-inline'] },
        hChildren: [{ type: 'text', value }],
      },
    },
    token,
  );
  this.buffer();
};
const exit: Handle = function (token) {
  this.resume();
  this.exit(token);
};

export function remarkLatex(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ flow: { 92: latexDisplay }, text: { 92: latexMath } });
  (data.fromMarkdownExtensions ??= []).push({
    enter: { latexMath: enter, latexDisplay: enterDisplay },
    exit: { latexMath: exit, latexDisplay: exitDisplay, latexDisplayData: displayData },
  });
}
