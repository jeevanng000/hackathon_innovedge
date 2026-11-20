import Prism from 'prismjs';
import { detectLanguageFromFilename, type SupportedLanguage } from './languageDetect';

/**
 * Ensures all 14 SupportedLanguage grammars are registered on Prism.languages
 * in both browser (Vite ESM) and Node (tsx unit test) environments without
 * relying on global side-effect import order.
 */
function ensurePrismGrammars(): void {
  const clikeBase: Prism.Grammar = Prism.languages.clike || {
    comment: [
      { pattern: /(^|[^\\])\/\*[\s\S]*?(?:\*\/|$)/, lookbehind: true, greedy: true },
      { pattern: /(^|[^\\:])\/\/.*/, lookbehind: true, greedy: true },
    ],
    string: {
      pattern: /(["'])(?:\\(?:\r\n|[\s\S])|(?!\1)[^\\\r\n])*\1/,
      greedy: true,
    },
    'class-name': {
      pattern: /(\b(?:class|interface|extends|implements|trait|instanceof|new)\s+|\bcatch\s+\()[\w.\\]+/i,
      lookbehind: true,
      inside: { punctuation: /[.\\]/ },
    },
    keyword: /\b(?:if|else|while|do|for|return|in|instanceof|function|new|try|throw|catch|finally|null|break|continue)\b/,
    boolean: /\b(?:true|false)\b/,
    function: /\b\w+(?=\()/,
    number: /\b0x[\da-f]+\b|(?:\b\d+(?:\.\d*)?|\B\.\d+)(?:e[+-]?\d+)?/i,
    operator: /[<>]=?|[!=]=?=?|--?|\+\+?|&&?|\|\|?|[?*/~^%]/,
    punctuation: /[{}[\];(),.:]/,
  };

  if (!Prism.languages.python) {
    Prism.languages.python = {
      comment: { pattern: /(^|[^\\])#.*/, lookbehind: true, greedy: true },
      'triple-quoted-string': {
        pattern: /(?:[rubf]|rf|fr)?("""|''')[\s\S]*?\1/i,
        greedy: true,
        alias: 'string',
      },
      string: {
        pattern: /(?:[rubf]|rf|fr)?(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/i,
        greedy: true,
      },
      decorator: {
        pattern: /(^[\t ]*)@\w+(?:\.\w+)*/m,
        lookbehind: true,
        alias: ['annotation', 'punctuation'],
      },
      'class-name': {
        pattern: /(\bclass\s+)\w+/i,
        lookbehind: true,
      },
      function: {
        pattern: /(\bdef\s+)\w+|(?:\b\w+(?=\())/i,
        lookbehind: true,
      },
      keyword:
        /\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/,
      builtin:
        /\b(?:abs|all|any|bool|bytes|callable|chr|dict|dir|divmod|enumerate|Exception|filter|float|format|frozenset|getattr|hasattr|hash|hex|id|input|int|isinstance|issubclass|iter|KeyError|len|list|map|max|min|next|object|oct|open|ord|pow|print|property|range|repr|reversed|round|set|setattr|slice|sorted|staticmethod|str|sum|super|tuple|type|TypeError|ValueError|vars|ZeroDivisionError|zip|IndexError|AttributeError)\b/,
      boolean: /\b(?:False|None|True)\b/,
      number: /\b0(?:b(?:_?[01])+|o(?:_?[0-7])+|x(?:_?[a-f0-9])+)\b|(?:\b\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\B\.\d+(?:_\d+)*)(?:e[+-]?\d+(?:_\d+)*)?j?\b/i,
      operator: /[-+%=]=?|!=|:=|\*\*?=?|\/\/?=?|<[<=>]?|>[=>]?|[&|^~]/,
      punctuation: /[{}[\];(),.:]/,
    };
  }

  if (!Prism.languages.typescript) {
    Prism.languages.typescript = Prism.languages.extend('javascript', {
      'class-name': {
        pattern: /(\b(?:class|extends|implements|instanceof|interface|new|type)\s+)[\w.\\]+/,
        lookbehind: true,
      },
      keyword:
        /\b(?:abstract|as|async|await|break|case|catch|class|const|constructor|continue|debugger|declare|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|infer|instanceof|interface|is|keyof|let|module|namespace|never|new|of|package|private|protected|public|readonly|require|return|satisfies|set|static|super|switch|this|throw|try|type|typeof|undefined|unique|unknown|var|void|while|with|yield)\b/,
      builtin:
        /\b(?:Array|BigInt|Boolean|Date|Error|Function|JSON|Map|Math|Number|Object|Promise|Proxy|RegExp|Set|String|Symbol|WeakMap|WeakSet|any|boolean|console|never|number|object|string|symbol|unknown|void)\b/,
    });
  }

  if (!Prism.languages.c) {
    Prism.languages.c = {
      ...clikeBase,
      directive: {
        pattern: /(^[\t ]*)#(?:include|define|ifdef|ifndef|endif|if|else|elif|pragma)\b.*/m,
        lookbehind: true,
        alias: 'keyword',
      },
      keyword:
        /\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|bool|size_t|uint32_t|int32_t|uint64_t|int64_t)\b/,
      boolean: /\b(?:true|false|NULL)\b/,
    };
  }

  if (!Prism.languages.cpp) {
    Prism.languages.cpp = {
      ...Prism.languages.c,
      keyword:
        /\b(?:alignas|alignof|and|Auto|bool|break|case|catch|char|class|const|constexpr|const_cast|continue|decltype|default|delete|do|double|dynamic_cast|else|enum|explicit|export|extern|final|float|for|friend|goto|if|inline|int|long|mutable|namespace|new|noexcept|nullptr|operator|override|private|protected|public|register|reinterpret_cast|return|short|signed|sizeof|static|static_assert|static_cast|struct|switch|template|this|thread_local|throw|try|typedef|typeid|typename|union|unsigned|using|virtual|void|volatile|wchar_t|while|std|vector|string|map|unordered_map)\b/,
      boolean: /\b(?:true|false|nullptr|NULL)\b/,
    };
  }

  if (!Prism.languages.java) {
    Prism.languages.java = {
      ...clikeBase,
      annotation: {
        pattern: /(^|[^.])@\w+/,
        lookbehind: true,
        alias: 'decorator',
      },
      keyword:
        /\b(?:abstract|assert|boolean|break|byte|case|catch|char|class|const|continue|default|do|double|else|enum|exports|extends|final|finally|float|for|goto|if|implements|import|instanceof|int|interface|long|module|native|new|null|open|opens|package|private|protected|provides|public|record|requires|return|short|static|strictfp|super|switch|synchronized|this|throw|throws|to|transient|transitive|try|uses|var|void|volatile|while|with|yield)\b/,
      builtin:
        /\b(?:String|Integer|Long|Double|Boolean|List|Map|Set|Optional|Object|System|Exception|RuntimeException|PreparedStatement|Connection|ResultSet)\b/,
    };
  }

  if (!Prism.languages.go) {
    Prism.languages.go = {
      ...clikeBase,
      keyword:
        /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/,
      builtin:
        /\b(?:bool|byte|complex64|complex128|error|float32|float64|int|int8|int16|int32|int64|rune|string|uint|uint8|uint16|uint32|uint64|uintptr|append|cap|close|complex|copy|delete|imag|len|make|new|panic|print|println|real|recover)\b/,
      boolean: /\b(?:iota|nil|true|false)\b/,
    };
  }

  if (!Prism.languages.rust) {
    Prism.languages.rust = {
      ...clikeBase,
      attribute: {
        pattern: /#!?\[.*?\]/,
        greedy: true,
        alias: 'decorator',
      },
      keyword:
        /\b(?:abstract|as|async|await|become|box|break|const|continue|crate|do|dyn|else|enum|extern|final|fn|for|if|impl|in|let|loop|macro|match|mod|move|mut|override|priv|pub|ref|return|self|Self|static|struct|super|trait|try|type|typeof|unsafe|unsized|use|virtual|where|while|yield)\b/,
      builtin:
        /\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Some|None|Ok|Err|Box|Rc|Arc)\b/,
      boolean: /\b(?:true|false)\b/,
    };
  }

  if (!Prism.languages.csharp) {
    Prism.languages.csharp = {
      ...clikeBase,
      keyword:
        /\b(?:abstract|add|alias|as|ascending|async|await|base|bool|break|by|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|descending|do|double|dynamic|else|enum|event|explicit|extern|finally|fixed|float|for|foreach|from|get|global|goto|group|if|implicit|in|init|int|interface|internal|into|is|join|let|lock|long|nameof|namespace|new|notnull|null|object|on|operator|orderby|out|override|params|partial|private|protected|public|readonly|record|ref|remove|required|return|sbyte|sealed|select|set|short|sizeof|stackalloc|static|string|struct|switch|this|throw|try|typeof|uint|ulong|unchecked|unmanaged|unsafe|ushort|using|value|var|virtual|void|volatile|when|where|while|with|yield)\b/,
    };
  }

  if (!Prism.languages.php) {
    Prism.languages.php = {
      ...clikeBase,
      variable: /\$+(?:\w+\b|(?=\{))/,
      keyword:
        /\b(?:abstract|and|array|as|break|callable|case|catch|class|clone|const|continue|declare|default|die|do|echo|else|elseif|empty|enddeclare|endfor|endforeach|endif|endswitch|endwhile|eval|exit|extends|final|finally|fn|for|foreach|function|global|goto|if|implements|include|include_once|instanceof|insteadof|interface|isset|list|match|namespace|new|or|parent|print|private|protected|public|readonly|require|require_once|return|self|static|switch|throw|trait|try|unset|use|var|while|xor|yield)\b/i,
    };
  }

  if (!Prism.languages.ruby) {
    Prism.languages.ruby = {
      comment: { pattern: /#.*|^=begin\s[\s\S]*?^=end/m, greedy: true },
      string: {
        pattern: /(["'])(?:\\.|(?!\1)[^\\\r\n])*\1/,
        greedy: true,
      },
      keyword:
        /\b(?:BEGIN|END|alias|and|begin|break|case|class|def|defined\?|do|else|elsif|end|ensure|for|if|in|module|next|nil|not|or|redo|rescue|retry|return|self|super|then|undef|unless|until|when|while|yield)\b/,
      boolean: /\b(?:true|false|nil)\b/,
      symbol: /:(?!\d)\w+[!?]?/,
      number: /\b0x[\da-f]+\b|(?:\b\d+(?:\.\d*)?|\B\.\d+)(?:e[+-]?\d+)?/i,
      operator: /[<>]=?|[!=]=?=?|--?|\+\+?|&&?|\|\|?|[?*/~^%]/,
      punctuation: /[{}[\];(),.:]/,
    };
  }

  if (!Prism.languages.bash) {
    Prism.languages.bash = {
      comment: { pattern: /(^|[^"{\\$])#.*/, lookbehind: true },
      string: [
        { pattern: /(["'])(?:\\[\s\S]|\$\([^)]+\)|\$(?!\()|`[^`]+`|(?!\1)[^\\`$])*\1/, greedy: true },
      ],
      variable: /\$(?:\w+|[!#?*@$]|\{[^}]+\}|\(\([^)]+\)\)|\([^)]+\))/,
      keyword:
        /\b(?:if|then|else|elif|fi|for|while|in|do|done|case|esac|function|select|until|return|exit|local|export|readonly|set|unset|shift|source)\b/,
      builtin:
        /\b(?:echo|printf|read|cd|pwd|pushd|popd|dirs|let|eval|exec|test|true|false|grep|sed|awk|cat|ls|rm|mkdir|cp|mv)\b/,
      number: /\b\d+\b/,
      operator: /&&|\|\||[<>]=?|[!=]=|[-+*/%]=?/,
      punctuation: /[{}[\];(),.:]/,
    };
  }

  if (!Prism.languages.sql) {
    Prism.languages.sql = {
      comment: [
        { pattern: /(^|[^\\])(?:\/\*[\s\S]*?\*\/|(?:--|\/\/|#).*)/, lookbehind: true },
      ],
      string: {
        pattern: /(^|[^@\\])("|')(?:\\[\s\S]|(?!\2)[^\\]|\2\2)*\2/,
        greedy: true,
        lookbehind: true,
      },
      function: /\b(?:AVG|COUNT|FIRST|FORMAT|LAST|LCASE|LEN|MAX|MID|MIN|MOD|NOW|ROUND|SUM|UCASE)\b/i,
      keyword:
        /\b(?:ACTION|ADD|AFTER|ALL|ALTER|ANALYZE|AND|ANY|AS|ASC|AUTHORIZATION|BACKUP|BEGIN|BETWEEN|BIGINT|BINARY|BIT|BLOB|BOOLEAN|BREAK|BROWSE|BULK|BY|CASCADE|CASE|CAST|CHAR|CHARACTER|CHECK|CHECKPOINT|CLOSE|CLUSTERED|COALESCE|COLLATE|COLUMN|COMMIT|COMPUTE|CONSTRAINT|CONTAINS|CONTINUE|CONVERT|CREATE|CROSS|CURRENT|CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|CURSOR|DATABASE|DATE|DATETIME|DEALLOCATE|DEC|DECIMAL|DECLARE|DEFAULT|DELETE|DENY|DESC|DISK|DISTINCT|DISTRIBUTED|DOUBLE|DROP|DUMMY|DUMP|ELSE|END|ERRLVL|ESCAPE|EXCEPT|EXEC|EXECUTE|EXISTS|EXIT|FETCH|FILE|FILLFACTOR|FLOAT|FOR|FOREIGN|FREETEXT|FROM|FULL|FUNCTION|GOTO|GRANT|GROUP|HAVING|HOLDLOCK|IDENTITY|IF|IN|INDEX|INNER|INSERT|INT|INTEGER|INTERSECT|INTO|IS|JOIN|KEY|KILL|LEFT|LIKE|LIMIT|LINENO|LOAD|MERGE|NATIONAL|NOCHECK|NONCLUSTERED|NOT|NULL|NULLIF|NUMERIC|OF|OFF|OFFSETS|ON|OPEN|OPTION|OR|ORDER|OUTER|OVER|PERCENT|PLAN|PRECISION|PRIMARY|PRINT|PROC|PROCEDURE|PUBLIC|RAISERROR|READ|REAL|RECONFIGURE|REFERENCES|REPLICATION|RESTORE|RESTRICT|RETURN|REVERT|REVOKE|RIGHT|ROLLBACK|ROWCOUNT|ROWGUIDCOL|RULE|SAVE|SCHEMA|SELECT|SESSION_USER|SET|SETUSER|SMALLINT|SOME|STATISTICS|SYSTEM_USER|TABLE|TEXT|THEN|TIME|TIMESTAMP|TINYINT|TOP|TRAN|TRANSACTION|TRIGGER|TRUNCATE|TSEQUAL|UNION|UNIQUE|UPDATE|UPDATETEXT|USE|USER|USING|VALUES|VARCHAR|VARYING|VIEW|WAITFOR|WHEN|WHERE|WHILE|WITH|WRITETEXT)\b/i,
      boolean: /\b(?:TRUE|FALSE|NULL)\b/i,
      number: /\b0x[\da-f]+\b|\b\d+(?:\.\d*)?|\B\.\d+\b/i,
      operator: /[-+*/=%^~]|&&?|\|\|?|!=?|<(?:=>?|<|>)?|>[>=]?/,
      punctuation: /[;[\]()`,.]/,
    };
  }

  if (!Prism.languages.generic) {
    Prism.languages.generic = clikeBase;
  }
}

ensurePrismGrammars();

/**
 * Resolves the effective Prism grammar key for a SupportedLanguage or filename.
 */
export function resolvePrismLanguage(
  language?: SupportedLanguage,
  filename?: string
): SupportedLanguage {
  if (language && language !== 'generic') {
    return language;
  }
  if (filename) {
    const detected = detectLanguageFromFilename(filename);
    if (detected !== 'generic') {
      return detected;
    }
  }
  return language ?? 'generic';
}

/**
 * Escapes plain text safely if fallback rendering is needed.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Highlights source or test code using Prism.js and returns HTML safe for
 * rendering inside a synchronized `<pre><code>` editor backdrop.
 * Appends a trailing space after a trailing newline so `<pre>` height matches `<textarea>`.
 */
export function highlightCodeWithPrism(
  code: string,
  language?: SupportedLanguage,
  filename?: string
): string {
  ensurePrismGrammars();
  if (!code) {
    return '';
  }
  const effectiveLang = resolvePrismLanguage(language, filename);
  const grammar =
    Prism.languages[effectiveLang] ??
    Prism.languages.javascript ??
    Prism.languages.generic;

  let highlighted: string;
  try {
    highlighted = grammar
      ? Prism.highlight(code, grammar, effectiveLang)
      : escapeHtml(code);
  } catch {
    highlighted = escapeHtml(code);
  }

  // If the code ends with a newline, `<pre>` collapses the final trailing newline
  // unless followed by a space/character. Appending a space keeps scrollHeight synced.
  if (code.endsWith('\n')) {
    highlighted += ' ';
  }

  return highlighted;
}
