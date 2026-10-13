import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreQuestionMarks } from "../src/questions.ts";

test("adds question marks to English questions read flat", () => {
  const cases: [string, string][] = [
    ["Can you check the footer and make it smaller.", "Can you check the footer and make it smaller?"],
    ["Is it working now", "Is it working now?"],
    ["Why is the build failing on main.", "Why is the build failing on main?"],
    ["I added the widget. Does it look okay to you.", "I added the widget. Does it look okay to you?"],
    ["So could we try a smaller model.", "So could we try a smaller model?"],
    ["Do you see the header.", "Do you see the header?"],
    ["What's left on the list.", "What's left on the list?"],
    ["How many tests fail.", "How many tests fail?"],
    ["That's the second pass, right.", "That's the second pass, right?"],
  ];
  for (const [input, expected] of cases) assert.equal(restoreQuestionMarks(input), expected, input);
});

test("adds both marks to Spanish questions", () => {
  const cases: [string, string][] = [
    ["Puedes revisar el archivo de configuración.", "¿Puedes revisar el archivo de configuración?"],
    ["Arreglé el error. Lo puedes probar ahora.", "Arreglé el error. ¿Lo puedes probar ahora?"],
    ["Y cuánto tarda la segunda pasada.", "¿Y cuánto tarda la segunda pasada?"],
    ["Por qué falla la compilación", "¿Por qué falla la compilación?"],
    ["Te parece bien así.", "¿Te parece bien así?"],
    ["Eso ya funciona, verdad.", "Eso ya funciona, ¿verdad?"],
    ["Eso ya funciona, ¿verdad.", "Eso ya funciona, ¿verdad?"],
    ["Ya está. ¿Lo pruebas tú.", "Ya está. ¿Lo pruebas tú?"],
  ];
  for (const [input, expected] of cases) assert.equal(restoreQuestionMarks(input), expected, input);
});

test("leaves statements, commands and existing marks alone", () => {
  const unchanged = [
    "Run the tests again and tell me what fails.",
    "What I mean is the header should be smaller.",
    "How it works is simple.",
    "When you are done, run the tests.",
    "Do it now.",
    "Have a look at the footer.",
    "Did it! Can you believe it!",
    "Is this right? Yes.",
    "Use version 3.5 for this.",
    "Ya probé la función y funciona muy bien.",
    "No, no.",
    "",
  ];
  for (const text of unchanged) assert.equal(restoreQuestionMarks(text), text, text);
});

test("keeps the spacing between sentences", () => {
  assert.equal(restoreQuestionMarks("Done.  Can we ship it.\n"), "Done.  Can we ship it?\n");
});
