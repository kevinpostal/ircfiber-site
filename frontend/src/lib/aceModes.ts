/** Ace editor syntax modes, mirroring IRCCloud's pastebin mode list
 *  (value = ace mode id, label = display name). */
export const ACE_MODES: ReadonlyArray<readonly [string, string]> = [
  ['text', 'Plain Text'], ['abap', 'ABAP'], ['abc', 'ABC'], ['actionscript', 'ActionScript'],
  ['ada', 'ADA'], ['alda', 'Alda'], ['apache_conf', 'Apache Conf'], ['apex', 'Apex'],
  ['aql', 'AQL'], ['asciidoc', 'AsciiDoc'], ['asl', 'ASL'], ['assembly_arm32', 'Assembly ARM32'],
  ['assembly_x86', 'Assembly x86'], ['astro', 'Astro'], ['autohotkey', 'AutoHotkey / AutoIt'],
  ['batchfile', 'BatchFile'], ['bibtex', 'BibTeX'], ['c_cpp', 'C and C++'], ['c9search', 'C9Search'],
  ['cirru', 'Cirru'], ['clojure', 'Clojure'], ['cobol', 'Cobol'], ['coffee', 'CoffeeScript'],
  ['coldfusion', 'ColdFusion'], ['crystal', 'Crystal'], ['csharp', 'C#'],
  ['csound_document', 'Csound Document'], ['csound_orchestra', 'Csound'], ['csound_score', 'Csound Score'],
  ['css', 'CSS'], ['curly', 'Curly'], ['cuttlefish', 'Cuttlefish'], ['d', 'D'], ['dart', 'Dart'],
  ['diff', 'Diff'], ['django', 'Django'], ['dockerfile', 'Dockerfile'], ['dot', 'Dot'],
  ['drools', 'Drools'], ['edifact', 'Edifact'], ['eiffel', 'Eiffel'], ['ejs', 'EJS'],
  ['elixir', 'Elixir'], ['elm', 'Elm'], ['erlang', 'Erlang'], ['flix', 'Flix'], ['forth', 'Forth'],
  ['fortran', 'Fortran'], ['fsharp', 'FSharp'], ['fsl', 'FSL'], ['ftl', 'FreeMarker'],
  ['gcode', 'Gcode'], ['gherkin', 'Gherkin'], ['gitignore', 'Gitignore'], ['glsl', 'Glsl'],
  ['gobstones', 'Gobstones'], ['golang', 'Go'], ['graphqlschema', 'GraphQLSchema'],
  ['groovy', 'Groovy'], ['haml', 'HAML'], ['handlebars', 'Handlebars'], ['haskell', 'Haskell'],
  ['haskell_cabal', 'Haskell Cabal'], ['haxe', 'haXe'], ['hjson', 'Hjson'], ['html', 'HTML'],
  ['html_elixir', 'HTML (Elixir)'], ['html_ruby', 'HTML (Ruby)'], ['ini', 'INI'], ['io', 'Io'],
  ['ion', 'Ion'], ['jack', 'Jack'], ['jade', 'Jade'], ['java', 'Java'], ['javascript', 'JavaScript'],
  ['jexl', 'JEXL'], ['json', 'JSON'], ['json5', 'JSON5'], ['jsoniq', 'JSONiq'], ['jsp', 'JSP'],
  ['jssm', 'JSSM'], ['jsx', 'JSX'], ['julia', 'Julia'], ['kotlin', 'Kotlin'], ['latex', 'LaTeX'],
  ['latte', 'Latte'], ['less', 'LESS'], ['liquid', 'Liquid'], ['lisp', 'Lisp'],
  ['livescript', 'LiveScript'], ['log', 'Log'], ['logiql', 'LogiQL'], ['logtalk', 'Logtalk'],
  ['lsl', 'LSL'], ['lua', 'Lua'], ['luapage', 'LuaPage'], ['lucene', 'Lucene'],
  ['makefile', 'Makefile'], ['markdown', 'Markdown'], ['mask', 'Mask'], ['matlab', 'MATLAB'],
  ['maze', 'Maze'], ['mediawiki', 'MediaWiki'], ['mel', 'MEL'], ['mips', 'MIPS'],
  ['mixal', 'MIXAL'], ['mushcode', 'MUSHCode'], ['mysql', 'MySQL'], ['nasal', 'Nasal'],
  ['nginx', 'Nginx'], ['nim', 'Nim'], ['nix', 'Nix'], ['nsis', 'NSIS'], ['nunjucks', 'Nunjucks'],
  ['objectivec', 'Objective-C'], ['ocaml', 'OCaml'], ['odin', 'Odin'], ['partiql', 'PartiQL'],
  ['pascal', 'Pascal'], ['perl', 'Perl'], ['pgsql', 'pgSQL'], ['php', 'PHP'],
  ['php_laravel_blade', 'PHP (Blade Template)'], ['pig', 'Pig'], ['plsql', 'PLSQL'],
  ['powershell', 'Powershell'], ['praat', 'Praat'], ['prisma', 'Prisma'], ['prolog', 'Prolog'],
  ['properties', 'Properties'], ['protobuf', 'Protobuf'], ['prql', 'PRQL'], ['puppet', 'Puppet'],
  ['python', 'Python'], ['qml', 'QML'], ['r', 'R'], ['raku', 'Raku'], ['razor', 'Razor'],
  ['rdoc', 'RDoc'], ['red', 'Red'], ['rhtml', 'RHTML'], ['robot', 'Robot'], ['rst', 'RST'],
  ['ruby', 'Ruby'], ['rust', 'Rust'], ['sac', 'SaC'], ['sass', 'SASS'], ['scad', 'SCAD'],
  ['scala', 'Scala'], ['scheme', 'Scheme'], ['scrypt', 'Scrypt'], ['scss', 'SCSS'], ['sh', 'SH'],
  ['sjs', 'SJS'], ['slim', 'Slim'], ['smarty', 'Smarty'], ['smithy', 'Smithy'],
  ['snippets', 'snippets'], ['soy_template', 'Soy Template'], ['space', 'Space'],
  ['sparql', 'SPARQL'], ['sql', 'SQL'], ['sqlserver', 'SQLServer'], ['stylus', 'Stylus'],
  ['svg', 'SVG'], ['swift', 'Swift'], ['tcl', 'Tcl'], ['terraform', 'Terraform'], ['tex', 'Tex'],
  ['textile', 'Textile'], ['toml', 'Toml'], ['tsx', 'TSX'], ['turtle', 'Turtle'], ['twig', 'Twig'],
  ['typescript', 'Typescript'], ['vala', 'Vala'], ['vbscript', 'VBScript'], ['velocity', 'Velocity'],
  ['verilog', 'Verilog'], ['vhdl', 'VHDL'], ['visualforce', 'Visualforce'], ['vue', 'Vue'],
  ['wollok', 'Wollok'], ['xml', 'XML'], ['xquery', 'XQuery'], ['yaml', 'YAML'], ['zeek', 'Zeek'],
  ['zig', 'Zig'],
];

const labelByValue = new Map(ACE_MODES);

/** Display label for an ace mode value; falls back to "Plain Text". */
export function aceModeLabel(value: string): string {
  return labelByValue.get(value) ?? 'Plain Text';
}
