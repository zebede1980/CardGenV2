# Image Generation Workflow Overhaul Plan

**1. UI Overhaul (`index.html`)**
- **Image Settings Container**: Insert a new grid layout container near the existing image controls to house the new configurations.
- **New Controls**: 
  - Model Selector (Z-Image-Turbo, Luma UNI-1 Max, Boogu Image, etc.)
  - Aspect Ratio (1:1, 9:16, 16:9)
  - Style Preset (Cinematic, Photorealistic, Digital Art, Anime)
  - Camera Profile (None, Nikon D810 Pro, Sony RX10 Macro, 35mm Anamorphic)
- **Draft & Refine Elements**: 
  - Keep the existing `prompt-guidance` field for user input.
  - Add a "Draft Image Prompt" button.
  - Add a disabled-by-default `textarea` named "Final Prompt Preview" that unlocks after a draft is generated.
  - Add the final "Generate Image from Prompt" action button, replacing the old instant generation flow.

**2. Frontend Logic (`src/scripts/app-ui.js` & `src/scripts/image-generator.js`)**
- Wire the new "Draft Image Prompt" button to collect the UI values (guidance, style, aspect ratio, model, camera) and character card state, then invoke a new `draftPrompt` function in the image generator.
- On success, populate and unlock the "Final Prompt Preview" text area so the user can make manual tweaks.
- Wire the "Generate Image from Prompt" button to read the *current* contents of the preview text area.
- Dynamically calculate API parameters (e.g., lower steps/CFG for turbo models, higher for standard models) based on the model chosen, then pass them to the image generation API.

**3. Frontend API layer (`src/scripts/api-image.js`)**
- Add a new `draftImagePrompt` method to call the backend's new draft endpoint.
- Update the existing image generation request logic to accept the new dynamic parameters (aspect ratio, steps, cfg scale) and pass them directly to the image engine.

**4. Backend Route (`storywriterbackend/app/routers/generation.py`)**
- Define a Pydantic schema for the new draft request containing all the necessary fields.
- Implement a new `POST` endpoint `/draft-prompt` (which falls under the `/generate` router prefix, making it accessible at `/api/generate/draft-prompt` typically).
- Instruct the `LLMService` via system prompt to weave the character state, style, aspect ratio, and specifically the technical EXIF/photography parameters (if a camera profile is chosen) into a cohesive, highly descriptive image prompt.
