import chess.pgn
import psycopg2
import psycopg2.extras
import zstandard as zstd
import io
import time

# ── CONFIG ────────────────────────────────────────────────────────────────────
PGN_ZST_PATH  = r"C:\Users\Absar\Downloads\lichess_db_standard_rated_2025-01.pgn.zst"
DB_DSN        = "dbname=chess user=postgres password=admin host=localhost port=5432"
GAME_LIMIT    = 1_000_000
BATCH_SIZE    = 5_000
# ─────────────────────────────────────────────────────────────────────────────

def get_or_create_player(cur, player_cache, username, title):
    if not username:
        return None
    if username in player_cache:
        return player_cache[username]
    cur.execute(
        "INSERT INTO players (username, title) VALUES (%s, %s) "
        "ON CONFLICT (username) DO UPDATE SET title = EXCLUDED.title "
        "RETURNING id",
        (username, title or None)
    )
    pid = cur.fetchone()[0]
    player_cache[username] = pid
    return pid

def safe_int(val):
    try:
        return int(val)
    except (TypeError, ValueError):
        return None

def parse_clock(comment):
    if not comment:
        return None
    try:
        start = comment.find('%clk ')
        if start == -1:
            return None
        time_str = comment[start+5:].split(']')[0].strip()
        parts = time_str.split(':')
        if len(parts) == 3:
            h, m, s = parts
            total_seconds = int(h)*3600 + int(m)*60 + float(s)
            return int(total_seconds * 1000)
    except Exception:
        return None
    return None

def flush(cur, game_rows, move_rows):
    psycopg2.extras.execute_values(cur, """
        INSERT INTO games
            (lichess_id, played_at, time_control, variant, result, termination,
             opening_eco, opening_name, white_id, black_id,
             white_elo, black_elo, white_elo_diff, black_elo_diff)
        VALUES %s
        ON CONFLICT (lichess_id) DO NOTHING
        RETURNING lichess_id, id
    """, game_rows, page_size=1000)

    id_map = {row[0]: row[1] for row in cur.fetchall()}

    real_move_rows = []
    for row in move_rows:
        lichess_id = row[0]
        game_db_id = id_map.get(lichess_id)
        if game_db_id is None:
            continue
        real_move_rows.append((game_db_id,) + row[1:])

    if real_move_rows:
        psycopg2.extras.execute_values(cur, """
            INSERT INTO moves
                (game_id, move_num, color, uci, san, piece,
                 from_sq, to_sq, is_capture, is_check, is_checkmate,
                 captured_piece, clock_ms)
            VALUES %s
            ON CONFLICT DO NOTHING
        """, real_move_rows, page_size=5000)

def ingest():
    conn = psycopg2.connect(DB_DSN)
    conn.autocommit = False
    cur = conn.cursor()

    player_cache = {}
    game_rows    = []
    move_rows    = []
    game_count   = 0
    start_time   = time.time()

    print(f"Opening {PGN_ZST_PATH} ...")

    dctx = zstd.ZstdDecompressor()
    with open(PGN_ZST_PATH, 'rb') as fh:
        with dctx.stream_reader(fh) as reader:
            f = io.TextIOWrapper(reader, encoding='utf-8', errors='replace')

            while game_count < GAME_LIMIT:
                try:
                    game = chess.pgn.read_game(f)
                except Exception:
                    continue
                if game is None:
                    print("Reached end of file.")
                    break

                h = game.headers
                lichess_id = h.get("Site", "").split("/")[-1]
                if not lichess_id:
                    continue

                white_user  = h.get("White", "")
                black_user  = h.get("Black", "")
                white_title = h.get("WhiteTitle", "")
                black_title = h.get("BlackTitle", "")
                white_id = get_or_create_player(cur, player_cache, white_user, white_title)
                black_id = get_or_create_player(cur, player_cache, black_user, black_title)

                date_str = h.get("UTCDate", "")
                time_str = h.get("UTCTime", "")
                played_at = None
                if date_str and time_str:
                    try:
                        played_at = date_str.replace(".", "-") + " " + time_str
                    except Exception:
                        pass

                white_elo      = safe_int(h.get("WhiteElo"))
                black_elo      = safe_int(h.get("BlackElo"))
                white_elo_diff = safe_int(h.get("WhiteRatingDiff"))
                black_elo_diff = safe_int(h.get("BlackRatingDiff"))

                game_rows.append((
                    lichess_id,
                    played_at,
                    h.get("TimeControl"),
                    h.get("Variant", "Standard"),
                    (h.get("Result") or "")[:10],
                    h.get("Termination"),
                    h.get("ECO"),
                    h.get("Opening"),
                    white_id,
                    black_id,
                    white_elo,
                    black_elo,
                    white_elo_diff,
                    black_elo_diff,
                ))

                board = game.board()
                move_num = 0
                for node in game.mainline():
                    move = node.move
                    try:
                        san = board.san(move)
                    except Exception:
                        board.push(move)
                        move_num += 1
                        continue

                    piece_obj    = board.piece_at(move.from_square)
                    captured_obj = board.piece_at(move.to_square)
                    is_capture   = board.is_capture(move)

                    if is_capture and captured_obj is None:
                        captured_sym = 'P'
                    else:
                        captured_sym = captured_obj.symbol().upper() if captured_obj else None

                    move_rows.append((
                        lichess_id,
                        move_num,
                        'w' if board.turn == chess.WHITE else 'b',
                        move.uci(),
                        san,
                        piece_obj.symbol().upper() if piece_obj else None,
                        chess.square_name(move.from_square),
                        chess.square_name(move.to_square),
                        is_capture,
                        '+' in san or '#' in san,
                        '#' in san,
                        captured_sym,
                        parse_clock(node.comment),
                    ))
                    board.push(move)
                    move_num += 1

                game_count += 1

                if game_count % BATCH_SIZE == 0:
                    flush(cur, game_rows, move_rows)
                    conn.commit()
                    game_rows  = []
                    move_rows  = []
                    elapsed = time.time() - start_time
                    rate    = game_count / elapsed
                    eta     = (GAME_LIMIT - game_count) / rate if rate > 0 else 0
                    print(f"  {game_count:,} games | {rate:.0f} games/sec | ETA {eta/60:.1f} min")

    if game_rows:
        flush(cur, game_rows, move_rows)
        conn.commit()

    cur.close()
    conn.close()
    elapsed = time.time() - start_time
    print(f"\nDone! {game_count:,} games in {elapsed/60:.1f} minutes.")

if __name__ == "__main__":
    ingest()