const https = require("https");
const zlib = require("zlib");
const querystring = require("querystring");
const { spawn } = require("child_process");
const prompts = require("prompts");
const fs = require("fs");
const path = require("path");
const { exit } = require("process");
const figlet = require("figlet");

const CONFIG_PATH = path.join(__dirname, "config.json");
const BASE_HOSTNAME = "ogladajanime.pl";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

class UserCancelledError extends Error {
  constructor(message = "Operacja anulowana przez użytkownika.") {
    super(message);
    this.name = "UserCancelledError";
  }
}

const loadConfig = () => {
  if (!fs.existsSync(CONFIG_PATH)) {
    const defaultConfig = { downloads_path: "./pobrane_anime" };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log(`Utworzono domyślny plik konfiguracyjny: ${CONFIG_PATH}`);
    return defaultConfig;
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!fs.existsSync(config.downloads_path)) {
    fs.mkdirSync(config.downloads_path, { recursive: true });
  }
  return config;
};

const decompressResponse = (res) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("error", reject);
    res.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const encoding = res.headers["content-encoding"];
      const callback = (err, d) =>
        err ? reject(err) : resolve(d.toString("utf-8"));
      if (encoding === "br") zlib.brotliDecompress(buffer, callback);
      else if (encoding === "gzip") zlib.gunzip(buffer, callback);
      else callback(null, buffer);
    });
  });
};

const request = (options, postData = null) => {
  return new Promise((resolve, reject) => {
    const req = https.request(options, resolve);
    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
};

const apiRequest = async ({
  path,
  method = "GET",
  cookies = "",
  postData = null,
  port = 443,
  refererPath = "/",
}) => {
  const options = {
    hostname: BASE_HOSTNAME,
    path,
    method,
    port,
    headers: {
      "User-Agent": USER_AGENT,
      "X-Requested-With": "XMLHttpRequest",
      Origin: `https://${BASE_HOSTNAME}`,
      Referer: `https://${BASE_HOSTNAME}${refererPath}`,
      Cookie: cookies,
    },
  };

  if (postData) {
    const data = querystring.stringify(postData);
    options.headers["Content-Type"] =
      "application/x-www-form-urlencoded; charset=UTF-8";
    options.headers["Content-Length"] = Buffer.byteLength(data);
    const res = await request(options, data);
    return decompressResponse(res);
  } else {
    const res = await request(options);
    return decompressResponse(res);
  }
};

const performLogin = (login, password) => {
  return new Promise((resolve, reject) => {
    https.get(`https://${BASE_HOSTNAME}`, (res) => {
      const phpSessId = res.headers["set-cookie"]?.find((c) =>
        c.startsWith("PHPSESSID="),
      );
      if (!phpSessId)
        return reject(new Error("Nie udało się uzyskać PHPSESSID."));

      const postData = querystring.stringify({ login, pass: password });
      const options = {
        hostname: BASE_HOSTNAME,
        path: "/manager.php?action=login",
        method: "POST",
        headers: {
          Cookie: phpSessId,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": USER_AGENT,
          "X-Requested-With": "XMLHttpRequest",
          Origin: `https://${BASE_HOSTNAME}`,
          Referer: `https://${BASE_HOSTNAME}/`,
        },
      };

      const req = https.request(options, (loginRes) => {
        let body = "";
        loginRes.on("data", (chunk) => (body += chunk));
        loginRes.on("end", () => {
          try {
            if (JSON.parse(body).data !== "OK")
              return reject(new Error("Umiesz wpisywać poprawnie swoje dane?"));
            const authCookies = loginRes.headers["set-cookie"];
            const userId = authCookies.find((c) => c.startsWith("user_id="));
            const userKey = authCookies.find((c) => c.startsWith("user_key="));
            if (!userId || !userKey)
              return reject(
                new Error("Nie udało się uzyskać ciasteczek autoryzacyjnych."),
              );
            const finalCookies = [phpSessId, userId, userKey]
              .map((c) => c.split(";")[0])
              .join("; ");
            resolve(finalCookies);
          } catch (e) {
            reject(
              new Error(
                "[error] Błąd przetwarzania odpowiedzi serwera po logowaniu.",
              ),
            );
          }
        });
      });
      req.on("error", (e) =>
        reject(new Error(`[error] Błąd zapytania logowania: ${e.message}`)),
      );
      req.write(postData);
      req.end();
    });
  });
};

const getAnimeNameSuggestions = async (cookies) => {
  try {
    const jsonString = await apiRequest({
      path: "/manager.php?action=get_anime_names",
      cookies,
    });
    const data = JSON.parse(jsonString);
    if (Array.isArray(data.json)) {
      return data.json;
    }
    throw new Error(
      "Jprdl, to miała być tablica nazw, a serwer odesłał jakieś gówno.",
    );
  } catch (error) {
    console.warn(`[error]: ${error.message}`);
    return [];
  }
};

const searchAnime = async (cookies, query) => {
  const postData = { page: 1, search_type: "name", search: query };
  const jsonString = await apiRequest({
    path: "/manager.php?action=get_search",
    method: "POST",
    cookies,
    postData,
  });
  const htmlContent = JSON.parse(jsonString).data;
  const matches = [...htmlContent.matchAll(/\/anime\/([a-zA-Z0-9_-]+)/g)];
  return [...new Set(matches.map((m) => m[1]))];
};

const getEpisodes = async (cookies, animeSlug) => {
  const html = await apiRequest({ path: `/anime/${animeSlug}`, cookies });
  const regex =
    /<li.*?class="[^"]*list-group-item[^"]*".*?title="(.*?)".*?ep_id="(\d+)".*?>/gs;
  const matches = [...html.matchAll(regex)];
  let episodeCounter = 0;
  let trailerCounter = 0;
  return matches.map((m) => {
    const title = m[1];
    const isTrailer = /zwiastun|trailer|teaser|zapowiedź/i.test(title);
    if (isTrailer) {
      trailerCounter++;
      return { title, ep_id: m[2], number: trailerCounter, type: "trailer" };
    } else {
      episodeCounter++;
      return { title, ep_id: m[2], number: episodeCounter, type: "episode" };
    }
  });
};

const fetchEpisodeLinks = async (cookies, episodeId, animeSlug) => {
  const jsonString = await apiRequest({
    path: `/Player/${episodeId}`,
    port: 8443,
    cookies,
    refererPath: `/anime/${animeSlug}`,
  });
  const data = JSON.parse(jsonString);
  if (!Array.isArray(data))
    throw new Error(
      "[error] Jprdl, to miała być tablica linków, a serwer odesłał jakieś gówno.",
    );
  return data;
};

const findFirstValidEpisodeLinks = async (cookies, episodes, animeSlug) => {
  console.log("\nSprawdzanie dostępnych jakości...");
  for (const episode of episodes.filter((ep) => ep.type === "episode")) {
    try {
      const links = await fetchEpisodeLinks(cookies, episode.ep_id, animeSlug);
      console.log(
        `Git, jakości zweryfikowane na podstawie odcinka: "${episode.title}"`,
      );
      return links;
    } catch (error) {
      console.warn(
        `Hell nah, nie udało się pobrać linków dla "${episode.title}". Próbuję następny...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
};

const playVideo = (videoUrl) => {
  return new Promise((resolve, reject) => {
    console.log("\nDobra, to lecimy!");
    const ytDlp = spawn("yt-dlp", ["-o", "-", videoUrl]);
    const mpv = spawn("mpv", ["-"]);
    ytDlp.stdout.pipe(mpv.stdin);
    ytDlp.stderr.on("data", (data) =>
      console.error(`[yt-dlp stderr]: ${data}`),
    );
    mpv.stderr.on("data", (data) => console.error(`[mpv stderr]: ${data}`));
    mpv.on("close", (code) => {
      console.log(`Odtwarzacz mpv zakończył działanie z kodem ${code}.`);
      resolve();
    });
    mpv.on("error", (err) => reject(new Error(`[error] mpv: ${err.message}`)));
    ytDlp.on("error", (err) =>
      reject(new Error(`[error] yt-dlp: ${err.message}`)),
    );
  });
};

const downloadVideo = (videoUrl, destinationPath) => {
  return new Promise((resolve, reject) => {
    console.log(` -> Pobieranie do: ${destinationPath}`);
    const ytDlp = spawn("yt-dlp", ["-o", destinationPath, videoUrl]);
    ytDlp.on("close", (code) => {
      if (code === 0) {
        console.log(" -> Pomyślnie pobrano!");
        resolve();
      } else {
        reject(new Error(`yt-dlp zakończył działanie z kodem błędu ${code}.`));
      }
    });
    ytDlp.on("error", (err) =>
      reject(new Error(`Błąd yt-dlp: ${err.message}`)),
    );
  });
};

const handleStreaming = async (cookies, episodes, animeSlug, onCancel) => {
  const { selectedEpisode } = await prompts(
    {
      type: "select",
      name: "selectedEpisode",
      message: "Mordo wybierz odcinek proszę.",
      choices: episodes.map((ep) => ({ title: ep.title, value: ep })),
    },
    { onCancel },
  );
  if (!selectedEpisode) return;

  try {
    const linksData = await fetchEpisodeLinks(
      cookies,
      selectedEpisode.ep_id,
      animeSlug,
    );
    linksData.sort((a, b) => (b.res || 0) - (a.res || 0));
    const { selectedLink } = await prompts(
      {
        type: "select",
        name: "selectedLink",
        message: "Mordo a teraz wybierz jakość proszę.",
        choices: linksData.map((link) => ({
          title: link.label,
          value: link.src,
        })),
      },
      { onCancel },
    );
    if (selectedLink) await playVideo(selectedLink);
  } catch (e) {
    console.error(
      `\n[error]: Nie udało się pobrać linków dla odcinka "${selectedEpisode.title}" lmao.`,
    );
  }
};

const handleDownloading = async (
  config,
  cookies,
  episodes,
  animeSlug,
  onCancel,
) => {
  const linksData = await findFirstValidEpisodeLinks(
    cookies,
    episodes,
    animeSlug,
  );
  if (!linksData) {
    console.error("\n[error]: Nie można określić dostępnych jakości.");
    return;
  }
  linksData.sort((a, b) => (b.res || 0) - (a.res || 0));

  const { selectedQuality } = await prompts(
    {
      type: "select",
      name: "selectedQuality",
      message: "Jaką jakość pobieramy mordo?",
      choices: linksData.map((link) => ({
        title: link.label,
        value: link.res,
      })),
    },
    { onCancel },
  );
  if (selectedQuality === undefined) return;

  const { episodesToDownload } = await prompts(
    {
      type: "multiselect",
      name: "episodesToDownload",
      message: "Zaznacz odcinki do pobrania",
      choices: episodes.map((ep) => ({ title: ep.title, value: ep })),
      hint: "- Użyj spacji/strzałek do zaznaczenia/nawigacji, a/enter do zatwierdzenia",
    },
    { onCancel },
  );
  if (!episodesToDownload || episodesToDownload.length === 0) {
    console.log("Nie wybrano żadnych odcinków.");
    return;
  }

  const animeDownloadPath = path.join(config.downloads_path, animeSlug);
  fs.mkdirSync(animeDownloadPath, { recursive: true });

  console.log(
    `\nRozpoczynanie pobierania ${episodesToDownload.length} odcinków...`,
  );
  for (const [i, episode] of episodesToDownload.entries()) {
    console.log(
      `\n[${i + 1}/${episodesToDownload.length}] Przetwarzanie: ${episode.title}`,
    );
    try {
      const episodeLinks = await fetchEpisodeLinks(
        cookies,
        episode.ep_id,
        animeSlug,
      );
      const targetLink = episodeLinks.find(
        (link) => link.res === selectedQuality,
      );
      if (!targetLink) {
        console.log(
          `[error] Jakość ${selectedQuality}p dla tego odcinka nie istnieje, pomijam.`,
        );
        continue;
      }
      const fileName =
        episode.type === "trailer"
          ? `Trailer ${episode.number}.mp4`
          : `Episode ${episode.number}.mp4`;
      const fullPath = path.join(animeDownloadPath, fileName);
      await downloadVideo(targetLink.src, fullPath);
    } catch (e) {
      console.error(`[error] ${episode.number}: ${e.message}`);
    }
  }
  console.log("\nGitara, pobrane!");
};

async function main() {
  const config = loadConfig();

  const onCancel = () => {
    throw new UserCancelledError();
  };

  try {
    // przywitanie
    console.clear();
    console.log(
      figlet.textSync("OgladajAnime", { font: "4Max" }),
      "scrapper by k0aziu (v1.0)",
    );
    console.log("");
    console.log(
      "Hej, napisałem scrapper aby móc pobierać anime na swój serwer i nie musieć obciążać słabego laptopa przeglądarką.",
    );
    console.log(
      "Ten kod jest przedsmakiem aplikacji na androida jaką chcę napisać do pobierania i oglądania anime (dostałem zgodę od właściciela ogladajanime).",
    );
    console.log(
      'Skrypcik może streamować anime i pobierać, w config.json ustaw "downloads_path", aby określić ścieżkę do katalogu, w którym mają być zapisywane pliki.',
    );
    console.log("Jest sporo błedów i się czasami wywala ale w teorii działa..");
    console.log("A i skrypt czasami cię zwyzywa.");
    console.log("Ogladajanime.pl pls don't sue me, please.");
    console.log("");
    console.log(`Zaloguj się do ogladajanime.pl:`);
    console.log("");

    const credentials = await prompts(
      [
        { type: "text", name: "login", message: "Podaj login" },
        { type: "password", name: "pass", message: "Podaj hasło" },
      ],
      { onCancel },
    );
    if (!credentials.login || !credentials.pass) return;

    console.log("\nLogowanie...");
    const cookies = await performLogin(credentials.login, credentials.pass);
    console.log("No brawo, zalogowałeś się.");

    const animeNameSuggestions = await getAnimeNameSuggestions(cookies);
    const animeChoices = animeNameSuggestions.map((title) => ({
      title,
      value: title,
    }));

    while (true) {
      try {
        const { searchQuery } = await prompts(
          {
            type: "autocomplete",
            name: "searchQuery",
            message: "\nNo wpisz jakąś nazwę anime",
            choices: animeChoices,
            suggest: (input, choices) => {
              if (!input) return choices;
              const lowercasedInput = input.toLowerCase();
              return choices.filter((choice) =>
                choice.title.toLowerCase().includes(lowercasedInput),
              );
            },
          },
          { onCancel },
        );
        if (!searchQuery) break;

        const searchResults = await searchAnime(cookies, searchQuery);
        if (searchResults.length === 0) {
          console.log("Jo nie znolozł nozwy.");
          continue;
        }

        const { selectedAnimeSlug } = await prompts(
          {
            type: "select",
            name: "selectedAnimeSlug",
            message: "Wybier anime z listy",
            choices: searchResults.map((slug) => ({
              title: slug.replace(/-/g, " "),
              value: slug,
            })),
          },
          { onCancel },
        );
        if (!selectedAnimeSlug) continue;

        const episodes = await getEpisodes(cookies, selectedAnimeSlug);
        if (episodes.length === 0) {
          console.log("Wtf co to za anime.");
          continue;
        }

        const { action } = await prompts(
          {
            type: "select",
            name: "action",
            message: "Pobieramy czy strimujemy?",
            choices: [
              { title: "Obejrzyj (Streaming)", value: "stream" },
              { title: "Pobierz odcinki", value: "download" },
            ],
          },
          { onCancel },
        );

        if (action === "stream") {
          await handleStreaming(cookies, episodes, selectedAnimeSlug, onCancel);
        } else if (action === "download") {
          await handleDownloading(
            config,
            cookies,
            episodes,
            selectedAnimeSlug,
            onCancel,
          );
        } else {
          continue;
        }

        const { searchAgain } = await prompts(
          {
            type: "confirm",
            name: "searchAgain",
            message: "Szukasz czegoś jeszcze wariacie?",
            initial: true,
          },
          { onCancel },
        );
        if (!searchAgain) break;
      } catch (error) {
        if (error instanceof UserCancelledError) {
          console.log("\nAnulowano. Powrót do wyszukiwania anime...\n");
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof UserCancelledError) {
    } else {
      console.error(`\n[error] ${error.message}`);
    }
  } finally {
    console.log("\nNara złamasie!");
    exit();
  }
}

main();
