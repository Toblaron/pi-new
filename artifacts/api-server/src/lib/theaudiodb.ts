const TIMEOUT_MS = 8000;

export interface TheAudioDBResult {
  genre?: string;
  mood?: string;
  style?: string;
  bpm?: number;
}

export async function fetchTheAudioDB(
  artist: string,
  title: string,
): Promise<TheAudioDBResult | null> {
  try {
    const url = new URL("https://www.theaudiodb.com/api/v1/json/2/searchtrack.php");
    url.searchParams.set("s", artist);
    url.searchParams.set("t", title);

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(url.toString(), { signal });

    if (!response.ok) return null;

    const data = await response.json() as TheAudioDBResponse;

    if (!data?.track || data.track.length === 0) return null;

    const track = data.track[0];

    const result: TheAudioDBResult = {};

    if (track.strGenre) result.genre = track.strGenre;
    if (track.strMood) result.mood = track.strMood;
    if (track.strStyle) result.style = track.strStyle;

    if (track.intBPM) {
      const bpm = parseInt(track.intBPM, 10);
      if (!isNaN(bpm) && bpm > 0) result.bpm = bpm;
    }

    if (Object.keys(result).length === 0) return null;

    return result;
  } catch {
    return null;
  }
}

interface TheAudioDBTrack {
  strGenre?: string | null;
  strMood?: string | null;
  strStyle?: string | null;
  intBPM?: string | null;
  intTotalPlays?: string | null;
}

interface TheAudioDBResponse {
  track?: TheAudioDBTrack[] | null;
}
