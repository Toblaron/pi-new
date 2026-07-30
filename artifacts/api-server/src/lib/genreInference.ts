// Genre inference helpers used by GET /api/suggest — maps MusicBrainz tags and
// genre labels to energy/tempo/vocals/instruments/moods suggestions.

// ─── Genre suggestion helpers ─────────────────────────────────────────────────

/** Map of normalised MusicBrainz tag names → our genre label */
const MB_TO_OUR_GENRE: Record<string, string> = {
  // Pop
  "pop": "Pop", "dance-pop": "Dance Pop", "dance pop": "Dance Pop",
  "indie pop": "Indie Pop", "electropop": "Electropop",
  "synth-pop": "Synth-Pop", "synthpop": "Synth-Pop", "synth pop": "Synth-Pop",
  "dream pop": "Dream Pop", "chamber pop": "Chamber Pop", "baroque pop": "Baroque Pop",
  "britpop": "Britpop", "power pop": "Power Pop", "teen pop": "Teen Pop",
  "art pop": "Art Pop", "bedroom pop": "Bedroom Pop",
  "k-pop": "K-Pop", "j-pop": "J-Pop", "kpop": "K-Pop", "jpop": "J-Pop",
  // Rock
  "rock": "Rock", "alternative rock": "Alternative Rock", "alt-rock": "Alternative Rock",
  "indie rock": "Indie Rock", "hard rock": "Hard Rock", "classic rock": "Classic Rock",
  "punk rock": "Punk", "punk": "Punk", "post-punk": "Post-Punk",
  "grunge": "Grunge", "shoegaze": "Shoegaze",
  "psychedelic rock": "Psychedelic Rock", "progressive rock": "Progressive Rock", "prog rock": "Progressive Rock",
  "garage rock": "Garage Rock", "folk rock": "Folk Rock",
  "blues-rock": "Blues-Rock", "blues rock": "Blues-Rock",
  "arena rock": "Arena Rock", "new wave": "New Wave",
  "emo": "Emo", "post-rock": "Post-Rock", "stoner rock": "Stoner Rock",
  // Hip-Hop
  "hip-hop": "Hip-Hop", "hip hop": "Hip-Hop", "rap": "Rap",
  "trap": "Trap", "drill": "Drill", "boom bap": "Boom Bap",
  "gangsta rap": "Gangsta Rap", "g-funk": "G-Funk",
  "conscious hip-hop": "Conscious Hip-Hop", "lo-fi hip-hop": "Lo-Fi Hip-Hop",
  "grime": "Grime", "cloud rap": "Cloud Rap",
  "east coast hip-hop": "East Coast", "west coast hip-hop": "West Coast Rap",
  "jazz rap": "Jazz Rap", "phonk": "Phonk",
  // R&B / Soul
  "r&b": "R&B", "rhythm and blues": "R&B",
  "soul": "Soul", "neo-soul": "Neo-Soul", "neo soul": "Neo-Soul",
  "funk": "Funk", "disco": "Disco", "motown": "Motown", "gospel": "Gospel",
  "contemporary r&b": "Contemporary R&B", "psychedelic soul": "Psychedelic Soul",
  "new jack swing": "New Jack Swing",
  // Jazz
  "jazz": "Jazz", "smooth jazz": "Smooth Jazz", "bebop": "Bebop", "swing": "Swing",
  "jazz fusion": "Jazz Fusion", "big band": "Big Band", "acid jazz": "Acid Jazz",
  "cool jazz": "Cool Jazz", "modal jazz": "Modal Jazz", "latin jazz": "Latin Jazz",
  "free jazz": "Free Jazz", "nu jazz": "Nu Jazz",
  // Metal
  "metal": "Metal", "heavy metal": "Heavy Metal", "black metal": "Black Metal",
  "death metal": "Death Metal", "thrash metal": "Thrash Metal",
  "nu-metal": "Nu Metal", "nu metal": "Nu Metal",
  "metalcore": "Metalcore", "power metal": "Power Metal",
  "doom metal": "Doom Metal", "symphonic metal": "Symphonic Metal",
  "djent": "Djent", "deathcore": "Deathcore",
  "progressive metal": "Progressive Metal", "folk metal": "Folk Metal",
  // Country / Folk
  "country": "Country", "country music": "Country", "americana": "Americana",
  "bluegrass": "Bluegrass", "folk": "Folk", "indie folk": "Indie Folk",
  "outlaw country": "Outlaw Country", "country rock": "Country Rock",
  "country pop": "Country Pop", "alt-country": "Alt-Country",
  "alternative country": "Alt-Country", "honky tonk": "Honky Tonk",
  "western swing": "Western Swing",
  // Classical
  "classical": "Classical", "orchestral": "Orchestral", "baroque": "Baroque",
  "chamber music": "Chamber Music", "opera": "Opera",
  "neoclassical": "Neo-Classical", "neo-classical": "Neo-Classical",
  "minimalist": "Minimalist", "minimal": "Minimalist", "romantic": "Romantic",
  "film score": "Film Score", "cinematic": "Cinematic",
  // World
  "reggae": "Reggae", "dancehall": "Dancehall", "reggaeton": "Reggaeton",
  "latin pop": "Latin Pop", "bossa nova": "Bossa Nova", "flamenco": "Flamenco",
  "salsa": "Salsa", "cumbia": "Cumbia", "afrobeats": "Afrobeats", "afropop": "Afropop",
  "ska": "Ska", "dub": "Dub", "tropical": "Tropical",
  // Blues
  "blues": "Blues", "delta blues": "Delta Blues", "chicago blues": "Chicago Blues",
  "electric blues": "Electric Blues",
  // Electronic — House
  "house": "House", "house music": "House",
  "deep house": "Deep House", "tech house": "Tech House",
  "progressive house": "Progressive House", "acid house": "Acid House",
  "melodic house": "Melodic House", "afro house": "Afro House",
  "soulful house": "Soulful House", "chicago house": "Chicago House",
  "tribal house": "Tribal House", "micro house": "Micro House",
  "nu disco": "Nu Disco",
  // Electronic — Techno
  "techno": "Techno", "berlin techno": "Berlin Techno", "detroit techno": "Detroit Techno",
  "minimal techno": "Minimal Techno", "hard techno": "Hard Techno",
  "industrial techno": "Industrial Techno", "dub techno": "Dub Techno",
  "acid techno": "Acid Techno", "hypnotic techno": "Hypnotic Techno",
  "dark techno": "Dark Techno", "modular techno": "Modular Techno",
  // Electronic — Trance
  "trance": "Trance", "progressive trance": "Progressive Trance",
  "uplifting trance": "Uplifting Trance",
  "psytrance": "Psytrance", "psy trance": "Psytrance", "psychedelic trance": "Psytrance",
  "goa trance": "Goa Trance", "tech trance": "Tech Trance",
  "vocal trance": "Vocal Trance", "future rave": "Future Rave",
  "dark psy": "Dark Psy", "forest psy": "Forest Psy",
  // Electronic — DnB / Jungle
  "drum and bass": "Drum & Bass", "drum & bass": "Drum & Bass", "dnb": "Drum & Bass",
  "liquid dnb": "Liquid DnB", "liquid drum and bass": "Liquid DnB",
  "neurofunk": "Neurofunk", "jungle": "Jungle", "darkstep": "Darkstep",
  "jump up": "Jump Up", "techstep": "Techstep", "drumstep": "Drumstep",
  // Electronic — Dubstep & Bass
  "dubstep": "Dubstep", "post-dubstep": "Post-Dubstep",
  "brostep": "Brostep", "riddim": "Riddim", "tearout": "Tearout",
  "halfstep": "Halfstep", "deathstep": "Deathstep",
  "future bass": "Future Bass", "wave": "Wave",
  // Electronic — Breakbeat
  "breakbeat": "Breakbeat", "big beat": "Big Beat",
  "chemical breaks": "Chemical Breaks", "glitch hop": "Glitch Hop",
  "nu-skool breaks": "Nu-Skool Breaks",
  // Electronic — Synthwave
  "synthwave": "Synthwave", "synth wave": "Synthwave",
  "darksynth": "Darksynth", "outrun": "Outrun", "retrowave": "Retrowave",
  "chillwave": "Chillwave", "italo disco": "Italo Disco",
  "hi-nrg": "Hi-NRG", "hi nrg": "Hi-NRG", "futurepop": "Futurepop",
  "new romanticism": "New Romanticism",
  // Electronic — Electro / EBM
  "electro": "Electro", "ebm": "EBM", "electronic body music": "EBM",
  "industrial": "Industrial", "aggrotech": "Aggrotech",
  "dark electro": "Dark Electro", "darkwave": "Darkwave",
  "cold wave": "Cold Wave", "coldwave": "Cold Wave",
  "power noise": "Power Noise", "post-industrial": "Post-Industrial",
  // Electronic — EDM
  "edm": "EDM", "electronic dance music": "EDM",
  "electro house": "Electro House", "big room": "Big Room",
  "complextro": "Complextro", "dutch house": "Dutch House",
  // Electronic — Ambient / IDM
  "ambient": "Ambient", "dark ambient": "Dark Ambient",
  "idm": "IDM", "intelligent dance music": "IDM",
  "glitch": "Glitch", "space music": "Space Music",
  "drone": "Drone Ambient", "drone ambient": "Drone Ambient",
  "isolationism": "Isolationism", "microsound": "Microsound",
  "generative": "Generative", "new age": "New Age",
  // Electronic — Trip-Hop / Downtempo
  "trip-hop": "Trip-Hop", "trip hop": "Trip-Hop",
  "downtempo": "Downtempo", "chillhop": "Chillhop",
  "lo-fi": "Lo-Fi", "lofi": "Lo-Fi", "chillout": "Chillout",
  "electronica": "Electronica",
  // Electronic — Vaporwave / Future Funk
  "vaporwave": "Vaporwave", "future funk": "Future Funk",
  "dreampunk": "Dreampunk", "mallsoft": "Mallsoft",
  "city pop": "City Pop Revival",
  "vaportrap": "Vaportrap", "hardvapour": "Hardvapour",
  // Electronic — Hardcore
  "hardcore": "Hardcore", "gabber": "Gabber", "hardstyle": "Hardstyle",
  "frenchcore": "Frenchcore", "happy hardcore": "Happy Hardcore",
  "uk hardcore": "UK Hardcore", "speedcore": "Speedcore",
  "rawstyle": "Rawstyle", "industrial hardcore": "Industrial Hardcore",
  // Electronic — UK Garage / Grime
  "uk garage": "UK Garage", "2-step": "2-Step", "2-step garage": "2-Step",
  "bassline": "Bassline", "uk bass": "UK Bass",
  "speed garage": "Speed Garage",
  // Electronic — Phonk / Hyperpop
  "memphis phonk": "Memphis Phonk", "slavic phonk": "Slavic Phonk",
  "drift phonk": "Drift Phonk", "dark phonk": "Dark Phonk",
  "hyperpop": "Hyperpop", "digicore": "Digicore",
  // Electronic — Afro
  "amapiano": "Amapiano", "gqom": "Gqom",
  "baile funk": "Baile Funk", "kuduro": "Kuduro",
  "footwork": "Footwork", "juke": "Juke", "kwaito": "Kwaito",
};

/** Maps matched genre names to an energy level */
const GENRE_TO_ENERGY: Record<string, string> = {
  "Ambient": "very chill", "Dark Ambient": "very chill",
  "Drone Ambient": "very chill", "Space Music": "very chill",
  "Isolationism": "very chill", "Microsound": "very chill",
  "Lo-Fi": "chill", "Trip-Hop": "chill", "Downtempo": "chill",
  "Chillhop": "chill", "Chillwave": "chill", "IDM": "chill",
  "New Age": "chill", "Nu Jazz": "chill", "Chillout": "chill",
  "Folk": "chill", "Indie Folk": "chill",
  "Jazz": "medium", "Smooth Jazz": "medium", "Blues": "medium",
  "Classical": "medium", "Orchestral": "medium", "Country": "medium",
  "Pop": "medium", "Rock": "medium", "R&B": "medium",
  "Soul": "medium", "Neo-Soul": "medium",
  "Indie Pop": "medium", "Indie Rock": "medium",
  "Bedroom Pop": "medium", "Dream Pop": "medium",
  "House": "high", "Trance": "high", "Techno": "high",
  "Hip-Hop": "high", "Trap": "high", "Funk": "high", "Disco": "high",
  "Electro": "high", "EBM": "high", "UK Garage": "high",
  "Grime": "high", "Synth-Pop": "high", "New Wave": "high",
  "Dance Pop": "high", "Electropop": "high",
  "Drum & Bass": "intense", "Liquid DnB": "high",
  "Neurofunk": "intense", "Darkstep": "intense",
  "Jump Up": "intense", "Jungle": "intense",
  "Hardstyle": "intense", "Hardcore": "intense",
  "Gabber": "intense", "Speedcore": "intense",
  "Industrial Hardcore": "intense", "Frenchcore": "intense",
  "Psytrance": "intense", "Hard Techno": "intense",
  "Tearout": "intense", "Deathstep": "intense",
  "Metal": "intense", "Heavy Metal": "intense",
  "Black Metal": "intense", "Death Metal": "intense",
  "Thrash Metal": "intense", "Metalcore": "intense",
};

/** Maps matched genre names to a tempo */
const GENRE_TO_TEMPO: Record<string, string> = {
  "Drum & Bass": "hyper", "Neurofunk": "hyper", "Darkstep": "hyper",
  "Jungle": "hyper", "Jump Up": "hyper", "Drumstep": "hyper",
  "Speedcore": "fast", "Gabber": "fast", "Frenchcore": "fast",
  "Hardcore": "fast", "Industrial Hardcore": "fast", "Hard Techno": "fast",
  "Hardstyle": "fast", "Psytrance": "fast", "Techno": "fast",
  "House": "uptempo", "Trance": "uptempo", "Dance Pop": "uptempo",
  "Electro House": "uptempo", "EDM": "uptempo", "Big Room": "uptempo",
  "UK Garage": "uptempo", "Breakbeat": "uptempo", "Big Beat": "uptempo",
  "Hip-Hop": "groove", "Funk": "groove", "R&B": "groove",
  "Disco": "groove", "Afrobeats": "groove", "Amapiano": "groove",
  "Footwork": "groove", "Boom Bap": "groove", "Grime": "groove",
  "Pop": "mid", "Rock": "mid", "Jazz": "mid",
  "Alternative Rock": "mid", "Indie Rock": "mid",
  "Soul": "mid", "Country": "mid",
  "Lo-Fi": "slow", "Downtempo": "slow", "Trip-Hop": "slow",
  "Ambient": "slow", "IDM": "slow", "Chillhop": "slow",
  "New Age": "slow", "Chillwave": "slow",
};

export function mapMbTagsToGenres(mbTags: string[]): string[] {
  const mapped: string[] = [];
  for (const tag of mbTags) {
    const key = tag.toLowerCase().trim();
    const genre = MB_TO_OUR_GENRE[key];
    if (genre && !mapped.includes(genre)) {
      mapped.push(genre);
    }
  }
  return mapped.slice(0, 5);
}

export function yearToEra(releaseYear?: string): string | null {
  if (!releaseYear) return null;
  const y = parseInt(releaseYear, 10);
  if (isNaN(y)) return null;
  if (y < 1960) return "50s";
  if (y < 1970) return "60s";
  if (y < 1980) return "70s";
  if (y < 1990) return "80s";
  if (y < 2000) return "90s";
  if (y < 2010) return "2000s";
  if (y < 2020) return "2010s";
  return "modern";
}

export function inferEnergy(genres: string[]): string | null {
  for (const g of genres) {
    const e = GENRE_TO_ENERGY[g];
    if (e) return e;
  }
  return null;
}

export function inferTempo(genres: string[]): string | null {
  for (const g of genres) {
    const t = GENRE_TO_TEMPO[g];
    if (t) return t;
  }
  return null;
}

// ─── Fallbacks: guarantee every /api/suggest field has a sensible value ──
// These are intentionally generic so they never mislead, but always non-empty.
export const DEFAULT_MOODS = ["Cinematic", "Dreamy", "Nostalgic", "Intense"] as const;
export const DEFAULT_INSTRUMENTS = ["Synth", "Bass", "Drums", "Piano", "Guitar"] as const;
export const DEFAULT_GENRES = ["Pop", "Indie Pop", "Synth-Pop", "Dance Pop", "Electropop"] as const;

const GENRE_TO_VOCALS: Record<string, string> = {
  "Trap": "male", "Drill": "male", "Boom Bap": "male", "Gangsta Rap": "male",
  "Phonk": "male", "Hip-Hop": "male", "Rap": "male", "Cloud Rap": "male", "G-Funk": "male",
  "Grime": "male", "Metal": "male", "Heavy Metal": "male", "Death Metal": "male",
  "Thrash Metal": "male", "Black Metal": "male", "Hard Rock": "male", "Punk": "male",
  "Soul": "mixed", "R&B": "mixed", "Neo-Soul": "mixed", "Gospel": "mixed",
  "Pop": "female", "Dance Pop": "female", "Synth-Pop": "female", "Electropop": "female",
  "Indie Pop": "female", "K-Pop": "female", "J-Pop": "female", "Dream Pop": "female",
  "Ambient": "no vocals", "Dark Ambient": "no vocals", "IDM": "no vocals",
  "Drone Ambient": "no vocals", "Cinematic": "no vocals", "Film Score": "no vocals",
  "Orchestral": "no vocals", "Classical": "no vocals", "Minimalist": "no vocals",
  "House": "mixed", "Deep House": "mixed", "Tech House": "no vocals",
  "Techno": "no vocals", "Berlin Techno": "no vocals", "Minimal Techno": "no vocals",
  "Trance": "mixed", "Drum & Bass": "mixed", "Dubstep": "no vocals",
};
export function inferVocals(genres: string[]): string {
  for (const g of genres) { if (GENRE_TO_VOCALS[g]) return GENRE_TO_VOCALS[g]; }
  return "mixed";
}

const GENRE_TO_INSTRUMENTS: Record<string, string[]> = {
  "Hip-Hop": ["808", "Sub Bass", "Synth", "Drums", "Pad"],
  "Trap": ["808", "Sub Bass", "Synth", "Drums", "Pad"],
  "Drill": ["808", "Sub Bass", "Synth", "Drums", "Pad"],
  "Phonk": ["808", "Synth", "Bass", "Drums", "Pad"],
  "Boom Bap": ["Piano", "Bass", "Drums", "Brass", "Saxophone"],
  "Rock": ["Electric Guitar", "Bass", "Drums", "Piano", "Synth"],
  "Indie Rock": ["Electric Guitar", "Bass", "Drums", "Synth", "Piano"],
  "Classic Rock": ["Electric Guitar", "Bass", "Drums", "Organ", "Piano"],
  "Hard Rock": ["Electric Guitar", "Bass", "Drums", "Synth", "Piano"],
  "Metal": ["Electric Guitar", "Bass", "Drums", "Synth", "Strings"],
  "Punk": ["Electric Guitar", "Bass", "Drums", "Synth", "Piano"],
  "Pop": ["Synth", "Bass", "Drums", "Piano", "Guitar"],
  "Dance Pop": ["Synth", "Bass", "Drums", "Piano", "Pad"],
  "Synth-Pop": ["Synth", "Bass", "Drums", "Pad", "Piano"],
  "Electropop": ["Synth", "Sub Bass", "Drums", "Pad", "Piano"],
  "House": ["Synth", "Sub Bass", "Drums", "Pad", "Piano"],
  "Deep House": ["Rhodes", "Sub Bass", "Drums", "Pad", "Synth"],
  "Tech House": ["Synth", "Sub Bass", "Drums", "Pad", "Piano"],
  "Techno": ["Synth", "Sub Bass", "Drums", "Pad", "Moog"],
  "Trance": ["Synth", "Pad", "Drums", "Sub Bass", "Strings"],
  "Drum & Bass": ["Sub Bass", "Drums", "Synth", "Pad", "Piano"],
  "Dubstep": ["Sub Bass", "Synth", "Drums", "Pad", "808"],
  "Synthwave": ["Synth", "Drums", "Bass", "Pad", "Piano"],
  "Country": ["Acoustic Guitar", "Bass", "Drums", "Pedal Steel", "Banjo"],
  "Folk": ["Acoustic Guitar", "Bass", "Violin", "Piano", "Harmonica"],
  "Jazz": ["Piano", "Bass", "Drums", "Saxophone", "Trumpet"],
  "R&B": ["Rhodes", "Bass", "Drums", "Piano", "Synth"],
  "Soul": ["Rhodes", "Bass", "Drums", "Brass", "Piano"],
  "Reggae": ["Bass", "Drums", "Guitar", "Organ", "Piano"],
  "Classical": ["Piano", "Violin", "Cello", "Strings", "Flute"],
  "Cinematic": ["Strings", "Piano", "Brass", "Drums", "Synth"],
  "Ambient": ["Pad", "Synth", "Piano", "Strings", "Drone"],
};
export function inferInstruments(genres: string[]): string[] {
  for (const g of genres) {
    const list = GENRE_TO_INSTRUMENTS[g];
    if (list && list.length >= 5) return list.slice(0, 5);
  }
  return [...DEFAULT_INSTRUMENTS];
}

const GENRE_TO_MOODS: Record<string, string[]> = {
  "Trap": ["Dark", "Aggressive", "Gritty", "Intense"],
  "Drill": ["Dark", "Aggressive", "Gritty", "Intense"],
  "Phonk": ["Dark", "Eerie", "Aggressive", "Murky"],
  "Hip-Hop": ["Gritty", "Defiant", "Raw", "Intense"],
  "Pop": ["Euphoric", "Hopeful", "Playful", "Romantic"],
  "Dance Pop": ["Euphoric", "Playful", "Groovy", "Hopeful"],
  "Synth-Pop": ["Nostalgic", "Dreamy", "Euphoric", "Wistful"],
  "Indie Pop": ["Dreamy", "Wistful", "Nostalgic", "Tender"],
  "Electropop": ["Euphoric", "Playful", "Groovy", "Punchy"],
  "Rock": ["Defiant", "Triumphant", "Raw", "Intense"],
  "Hard Rock": ["Aggressive", "Defiant", "Raw", "Intense"],
  "Punk": ["Aggressive", "Defiant", "Rebellious", "Raw"],
  "Metal": ["Aggressive", "Dark", "Intense", "Brooding"],
  "House": ["Euphoric", "Groovy", "Hypnotic", "Blissful"],
  "Deep House": ["Soulful", "Groovy", "Hypnotic", "Laid-back"],
  "Techno": ["Hypnotic", "Dark", "Intense", "Brooding"],
  "Trance": ["Euphoric", "Cinematic", "Hypnotic", "Transcendent"],
  "Drum & Bass": ["Intense", "Frantic", "Punchy", "Euphoric"],
  "Dubstep": ["Aggressive", "Punchy", "Intense", "Chaotic"],
  "Synthwave": ["Nostalgic", "Cinematic", "Dreamy", "Wistful"],
  "Ambient": ["Serene", "Ethereal", "Dreamy", "Transcendent"],
  "Cinematic": ["Cinematic", "Epic", "Majestic", "Triumphant"],
  "Folk": ["Nostalgic", "Tender", "Wistful", "Intimate"],
  "Country": ["Wistful", "Nostalgic", "Tender", "Hopeful"],
  "Jazz": ["Groovy", "Soulful", "Intimate", "Laid-back"],
  "R&B": ["Sensual", "Soulful", "Romantic", "Tender"],
  "Soul": ["Soulful", "Cathartic", "Tender", "Triumphant"],
  "Classical": ["Majestic", "Serene", "Cinematic", "Wistful"],
};
export function inferMoods(genres: string[], validSet: Set<string>): string[] {
  for (const g of genres) {
    const list = GENRE_TO_MOODS[g]?.filter((m) => validSet.has(m));
    if (list && list.length >= 4) return list.slice(0, 4);
  }
  return [...DEFAULT_MOODS];
}

export function inferNudge(genres: string[], energy: string, tempo: string): string {
  const lead = genres[0] ?? "pop";
  const tone = energy === "intense" || energy === "high" ? "punchy" : energy === "very chill" || energy === "chill" ? "laid-back" : "polished";
  const flavour = tempo === "ballad" || tempo === "slow" ? "atmospheric textures" : tempo === "hyper" || tempo === "fast" ? "driving rhythm section" : "groovy mid-tempo bounce";
  return `${tone} ${lead.toLowerCase()} with ${flavour}`;
}
