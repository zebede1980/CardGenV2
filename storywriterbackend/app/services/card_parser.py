import base64
import json
import zlib
from io import BytesIO
from typing import Optional, Dict, Any
from PIL import Image

def extract_chara_data(image_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Extract SillyTavern character data from PNG tEXt chunks."""
    img = Image.open(BytesIO(image_bytes))
    if not hasattr(img, 'text') or not img.text:
        return None
    
    chara_b64 = img.text.get('chara') or img.text.get('Chara')
    if not chara_b64:
        return None
    
    try:
        decoded = base64.b64decode(chara_b64)
        # Some cards may be zlib compressed
        try:
            decompressed = zlib.decompress(decoded)
            data = json.loads(decompressed)
        except Exception:
            data = json.loads(decoded)
        return data
    except Exception:
        return None

def parse_card(image_bytes: bytes) -> Optional[Dict[str, Any]]:
    """Parse a SillyTavern v2/v3 character card from image bytes."""
    data = extract_chara_data(image_bytes)
    if not data:
        return None
    
    # v3 spec wraps everything in 'data' key
    if 'data' in data:
        card_data = data['data']
        spec_version = data.get('spec', 'unknown')
        spec_version_full = data.get('spec_version', spec_version)
    else:
        card_data = data
        spec_version = '2.0'
        spec_version_full = '2.0'
    
    # Extract lorebook / character_book
    character_book = None
    if 'character_book' in card_data:
        character_book = card_data['character_book']
    elif 'lorebook' in card_data:
        character_book = card_data['lorebook']
    elif 'data' in card_data and 'character_book' in card_data['data']:
        character_book = card_data['data']['character_book']
    
    # Build normalized card dict
    result = {
        'name': card_data.get('name', 'Unknown'),
        'description': card_data.get('description', ''),
        'personality': card_data.get('personality', ''),
        'scenario': card_data.get('scenario', ''),
        'first_mes': card_data.get('first_mes', ''),
        'mes_example': card_data.get('mes_example', ''),
        'creatorcomment': card_data.get('creatorcomment', card_data.get('creator_notes', '')),
        'tags': ', '.join(card_data.get('tags', [])) if isinstance(card_data.get('tags'), list) else card_data.get('tags', ''),
        'creator': card_data.get('creator', ''),
        'character_version': card_data.get('character_version', card_data.get('version', '')),
        'alternate_greetings': json.dumps(card_data.get('alternate_greetings', [])) if isinstance(card_data.get('alternate_greetings'), list) else card_data.get('alternate_greetings', ''),
        'system_prompt': card_data.get('system_prompt', ''),
        'post_history_instructions': card_data.get('post_history_instructions', ''),
        'character_book': json.dumps(character_book) if character_book else '',
        'spec_version': spec_version_full,
    }
    return result

def get_lorebook_entries(character_book_json: str) -> list:
    """Parse lorebook JSON and return list of entries."""
    if not character_book_json:
        return []
    try:
        book = json.loads(character_book_json)
        entries = book.get('entries', [])
        return entries
    except Exception:
        return []
