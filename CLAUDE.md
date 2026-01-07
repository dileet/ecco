## General
- Do NOT write comments in the code
- Do NOT write documentation 
- Never self call functions
- Don't add packages directly. Make sure to run bun add or bun remove
- Follow functional patterns, DO NOT write OOP
- Never use npx, only bunx
- Use canonical JSON for cryptographic signatures
- Never write a self calling function

## Typescript
- Never use the "any" type
- Never do type assertion like as unknown or as any. Types should work

## Zod
- Use Zod when possible
- Use zod parse or safeParse when needed