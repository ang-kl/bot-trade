/*
 * scripts/tick-recorder-soak-faults.c — V3 R2 (P8d, corrected): the
 * filesystem fault layer for the recorder soak, as an LD_PRELOAD shim.
 *
 * The tick plan's storage soak (plan §16, :283) asks that "faults produce
 * accurate counters" for slow disk, short writes, ENOSPC / EIO, failed rename
 * and unwritable mounts. A free-space probe cannot produce any of those — the
 * recorder's own calls have to fail — so this shim interposes the stdio and
 * POSIX calls the recorder makes (fopen, fwrite, fflush, fsync, rename,
 * unlink) and fails them on command, ONLY for paths under the spool directory
 * the driver names (and the FILE*s opened there). Nothing is faked outside
 * that directory, and nothing here is built into, linked into or shipped with
 * a gateway: it lives in scripts/, and scripts/tick-recorder-soak.mjs builds
 * it next to the driver.
 *
 * CONTROL. The driver (scripts/tick-recorder-soak-driver.cpp) finds
 * `soak_fault_set` with dlsym(RTLD_DEFAULT) — present only when this shim is
 * preloaded — and switches the mode at its scripted times. Without the shim
 * the driver reports every shim fault as not applied, never as passed.
 *
 * Build: cc -shared -fPIC -O2 -o soak-faults.so scripts/tick-recorder-soak-faults.c -ldl
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

enum {
  SOAK_NONE = 0, SOAK_EIO_WRITE = 1, SOAK_SHORT_WRITE = 2, SOAK_ENOSPC_WRITE = 3, SOAK_EIO_FSYNC = 4,
  SOAK_RENAME_FAIL = 5, SOAK_UNLINK_FAIL = 6, SOAK_UNWRITABLE = 7, SOAK_SLOW = 8,
};

static _Atomic int g_mode = SOAK_NONE;
static char g_dir[4096];
static size_t g_dirLen = 0;
static _Atomic unsigned long g_hits = 0;

#define MAX_TRACKED 64
static FILE* g_files[MAX_TRACKED];
static pthread_mutex_t g_mtx = PTHREAD_MUTEX_INITIALIZER;

/* Exported: the driver's switch. `dir` scopes every fault to the spool. */
void soak_fault_set(int mode, const char* dir) {
  if (dir) {
    pthread_mutex_lock(&g_mtx);
    strncpy(g_dir, dir, sizeof g_dir - 1);
    g_dir[sizeof g_dir - 1] = 0;
    g_dirLen = strlen(g_dir);
    pthread_mutex_unlock(&g_mtx);
  }
  atomic_store(&g_mode, mode);
}
/* Exported: how many calls the shim has failed or slowed (the driver reports it). */
unsigned long soak_fault_hits(void) { return atomic_load(&g_hits); }

static int under(const char* path) {
  return path && g_dirLen > 0 && strncmp(path, g_dir, g_dirLen) == 0 && (path[g_dirLen] == '/' || path[g_dirLen] == 0);
}
static void track(FILE* f) {
  pthread_mutex_lock(&g_mtx);
  for (int i = 0; i < MAX_TRACKED; ++i) if (!g_files[i]) { g_files[i] = f; break; }
  pthread_mutex_unlock(&g_mtx);
}
static void untrack(FILE* f) {
  pthread_mutex_lock(&g_mtx);
  for (int i = 0; i < MAX_TRACKED; ++i) if (g_files[i] == f) g_files[i] = NULL;
  pthread_mutex_unlock(&g_mtx);
}
static int tracked(FILE* f) {
  int hit = 0;
  pthread_mutex_lock(&g_mtx);
  for (int i = 0; i < MAX_TRACKED; ++i) if (g_files[i] == f) { hit = 1; break; }
  pthread_mutex_unlock(&g_mtx);
  return hit;
}
static int writing(const char* mode) { return mode && (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+')); }

typedef FILE* (*fopen_t)(const char*, const char*);
typedef int (*fclose_t)(FILE*);
typedef size_t (*fwrite_t)(const void*, size_t, size_t, FILE*);
typedef int (*fflush_t)(FILE*);
typedef int (*fsync_t)(int);
typedef int (*rename_t)(const char*, const char*);
typedef int (*unlink_t)(const char*);
#define REAL(name, type) static type real_##name = NULL; if (!real_##name) real_##name = (type)dlsym(RTLD_NEXT, #name)

FILE* fopen(const char* path, const char* mode) {
  REAL(fopen, fopen_t);
  if (under(path) && writing(mode) && atomic_load(&g_mode) == SOAK_UNWRITABLE) { atomic_fetch_add(&g_hits, 1); errno = EROFS; return NULL; }
  FILE* f = real_fopen(path, mode);
  if (f && under(path)) track(f);
  return f;
}
FILE* fopen64(const char* path, const char* mode) {
  REAL(fopen64, fopen_t);
  if (under(path) && writing(mode) && atomic_load(&g_mode) == SOAK_UNWRITABLE) { atomic_fetch_add(&g_hits, 1); errno = EROFS; return NULL; }
  FILE* f = real_fopen64(path, mode);
  if (f && under(path)) track(f);
  return f;
}
int fclose(FILE* f) {
  REAL(fclose, fclose_t);
  untrack(f);
  return real_fclose(f);
}
size_t fwrite(const void* ptr, size_t size, size_t n, FILE* f) {
  REAL(fwrite, fwrite_t);
  if (tracked(f)) {
    const int m = atomic_load(&g_mode);
    if (m == SOAK_EIO_WRITE) { atomic_fetch_add(&g_hits, 1); errno = EIO; return 0; }
    if (m == SOAK_ENOSPC_WRITE) { atomic_fetch_add(&g_hits, 1); errno = ENOSPC; return 0; }
    if (m == SOAK_SHORT_WRITE && n > 1) { atomic_fetch_add(&g_hits, 1); return real_fwrite(ptr, size, n / 2 + 1, f); }
    if (m == SOAK_SLOW) { atomic_fetch_add(&g_hits, 1); usleep(20000); }
  }
  return real_fwrite(ptr, size, n, f);
}
int fflush(FILE* f) {
  REAL(fflush, fflush_t);
  if (f && tracked(f)) {
    const int m = atomic_load(&g_mode);
    if (m == SOAK_EIO_WRITE) { atomic_fetch_add(&g_hits, 1); errno = EIO; return EOF; }
  }
  return real_fflush(f);
}
int fsync(int fd) {
  REAL(fsync, fsync_t);
  const int m = atomic_load(&g_mode);
  /* The driver process fsyncs nothing but the spool's files and directory. */
  if (m == SOAK_EIO_FSYNC) { atomic_fetch_add(&g_hits, 1); errno = EIO; return -1; }
  if (m == SOAK_SLOW) { atomic_fetch_add(&g_hits, 1); usleep(50000); }
  return real_fsync(fd);
}
int rename(const char* from, const char* to) {
  REAL(rename, rename_t);
  if (under(from) && atomic_load(&g_mode) == SOAK_RENAME_FAIL) { atomic_fetch_add(&g_hits, 1); errno = EIO; return -1; }
  return real_rename(from, to);
}
int unlink(const char* path) {
  REAL(unlink, unlink_t);
  if (under(path) && atomic_load(&g_mode) == SOAK_UNLINK_FAIL) { atomic_fetch_add(&g_hits, 1); errno = EIO; return -1; }
  return real_unlink(path);
}
