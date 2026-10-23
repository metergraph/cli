#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <signal.h>

/* Private, bounded pipe protocol. No paths or file contents are logged. All
 * pathname lookups below the process root are relative to retained dirfds.
 * This process has no network interface or arbitrary execution operation. */
#define LIMIT (2 * 1024 * 1024)
#define MAX_HANDLES 8192
#define STAT_BYTES (11 * 8)
/* Search permission is sufficient for *at traversal; acquiring a directory
 * capability must not newly require directory-listing permission. */
#if defined(O_SEARCH)
#define DIRECTORY_ACCESS O_SEARCH
#elif defined(O_PATH)
#define DIRECTORY_ACCESS O_PATH
#else
#error "No search-only directory capability API on this target"
#endif
struct directory { int fd, parent; char *path, *name; dev_t dev; ino_t ino; };
static struct directory dirs[MAX_HANDLES];
static int ndirs = 0, rollback_mode = 0;
struct entry { int parent; char *name; dev_t dev; ino_t ino; int owned; dev_t own_dev; ino_t own_ino; };
static struct entry entries[MAX_HANDLES];
static int nentries;
static int files[MAX_HANDLES];
static int nfiles;
static int readall(int fd, void *data, size_t len) {
  unsigned char *p=data;
  while(len) { ssize_t n=read(fd,p,len); if(n<0 && errno==EINTR) continue; if(n<=0) return -1; p+=n; len-=n; } return 0;
}
static int writeall(int fd, const void *data, size_t len) {
  const unsigned char *p=data;
  while(len) { ssize_t n=write(fd,p,len); if(n<0 && errno==EINTR) continue; if(n<=0) return -1; p+=n; len-=n; } return 0;
}
static uint32_t get32(const unsigned char *p) { return (uint32_t)p[0]<<24 | (uint32_t)p[1]<<16 | (uint32_t)p[2]<<8 | p[3]; }
static void put32(unsigned char *p,uint32_t n) { p[0]=n>>24;p[1]=n>>16;p[2]=n>>8;p[3]=n; }
static void put64(unsigned char *p,uint64_t n) { for(int i=7;i>=0;i--) {p[i]=n&255;n>>=8;} }
static int reply(int error,const void *data,uint32_t len) {
  unsigned char h[8]; put32(h,error);put32(h+4,len);
  return writeall(1,h,8) || (len && writeall(1,data,len));
}
static int basename_ok(const char *p) { return *p && strcmp(p,".") && strcmp(p,"..") && !strchr(p,'/'); }
static int current(int idx) {
  if(idx==0) return 1;
  struct directory *d=&dirs[idx]; struct stat s;
  if(!current(d->parent)) return 0;
  if(fstatat(dirs[d->parent].fd,d->name,&s,AT_SYMLINK_NOFOLLOW)<0) return 0;
  return S_ISDIR(s.st_mode) && s.st_dev==d->dev && s.st_ino==d->ino;
}
static int remember(int parent,const char *name,const struct stat *s);
static int directory(const char *path) {
  if(!path || path[0]!='/' || strlen(path)>=PATH_MAX) {errno=EINVAL;return -1;}
  for(int i=0;i<ndirs;i++) if(dirs[i].fd>=0 && !strcmp(path,dirs[i].path)) return i;
  if(!strcmp(path,"/")) return 0;
  char *copy=strdup(path); if(!copy) return -1;
  char *slash=strrchr(copy,'/'); char *name=strdup(slash+1);
  if(!name || !basename_ok(name)) {free(copy);free(name);errno=EINVAL;return -1;}
  if(slash==copy) slash[1]=0; else *slash=0;
  int parent=directory(copy); free(copy);
  if(parent<0) {free(name);return -1;}
  int fd=openat(dirs[parent].fd,name,DIRECTORY_ACCESS|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(fd<0) {free(name);return -1;}
  struct stat s;
  if(fstat(fd,&s)<0 || !S_ISDIR(s.st_mode) || ndirs>=MAX_HANDLES) {close(fd);free(name);errno=EIO;return -1;}
  /* A previous directory observation is a capability identity, not permission
   * to adopt whatever object later occupies that spelling. */
  for(int i=0;i<nentries;i++) if(entries[i].parent==parent && !strcmp(entries[i].name,name)) {
    if(entries[i].dev!=s.st_dev || entries[i].ino!=s.st_ino) {close(fd);free(name);errno=ESTALE;return -1;}
  }
  int idx=ndirs++;
  dirs[idx]=(struct directory){fd,parent,strdup(path),name,s.st_dev,s.st_ino};
  remember(parent,name,&s);
  return idx;
}
static int parent_for(const char *path,char **name) {
  if(!path || path[0]!='/' || strlen(path)>=PATH_MAX) {errno=EINVAL;return -1;}
  char *copy=strdup(path); if(!copy) return -1;
  char *slash=strrchr(copy,'/'); *name=strdup(slash+1);
  if(!*name || !basename_ok(*name)) {free(copy);free(*name);*name=NULL;errno=EINVAL;return -1;}
  if(slash==copy) slash[1]=0; else *slash=0;
  int parent=directory(copy);free(copy);return parent;
}
static int mutable_parent(int idx) { if(idx<0)return 0; if(!rollback_mode && !current(idx)) {errno=ESTALE;return 0;} return 1; }
static int remember(int parent,const char *name,const struct stat *s) {
  for(int i=0;i<nentries;i++) if(entries[i].parent==parent && !strcmp(entries[i].name,name)) {
    entries[i].dev=s->st_dev;entries[i].ino=s->st_ino;return 0;
  }
  if(nentries>=MAX_HANDLES) {errno=EMFILE;return -1;}
  entries[nentries++]=(struct entry){parent,strdup(name),s->st_dev,s->st_ino,0,0,0};return 0;
}
static int own(int parent,const char *name,const struct stat *s) {
  if(remember(parent,name,s)<0)return -1;
  for(int i=0;i<nentries;i++) if(entries[i].parent==parent && !strcmp(entries[i].name,name)) {entries[i].owned=1;entries[i].own_dev=s->st_dev;entries[i].own_ino=s->st_ino;return 0;}
  errno=EIO;return -1;
}
static int promote(int parent,const char *name,const struct stat *s) {
  if(remember(parent,name,s)<0)return -1;
  for(int i=0;i<nentries;i++) if(entries[i].parent==parent && !strcmp(entries[i].name,name)) {entries[i].owned=0;return 0;}
  errno=EIO;return -1;
}
static int expected(int parent,const char *name,int use_owned) {
  for(int i=0;i<nentries;i++) if(entries[i].parent==parent && !strcmp(entries[i].name,name)) {
    struct stat s; if(fstatat(dirs[parent].fd,name,&s,AT_SYMLINK_NOFOLLOW)<0)return -1;
    dev_t dev=use_owned && entries[i].owned?entries[i].own_dev:entries[i].dev;
    ino_t ino=use_owned && entries[i].owned?entries[i].own_ino:entries[i].ino;
    if(s.st_dev!=dev || s.st_ino!=ino) {errno=ESTALE;return -1;}
    return 0;
  }
  errno=ESTALE;return -1;
}
static void statbytes(unsigned char *out,const struct stat *s) {
#if defined(__APPLE__)
  struct timespec modified=s->st_mtimespec, changed=s->st_ctimespec;
#else
  struct timespec modified=s->st_mtim, changed=s->st_ctim;
#endif
  /* Keep seconds and nanoseconds separate. Multiplying time_t by 1e9 here
   * would overflow for timestamps which JavaScript BigInt can represent. */
  uint64_t fields[]={s->st_dev,s->st_ino,s->st_mode,s->st_nlink,s->st_uid,s->st_gid,s->st_size,
    (uint64_t)modified.tv_sec,(uint64_t)modified.tv_nsec,(uint64_t)changed.tv_sec,(uint64_t)changed.tv_nsec};
  for(int i=0;i<11;i++)put64(out+i*8,fields[i]);
}
static int filefd(const char *s) { char *end;long n=strtol(s,&end,10); if(*end || n<0 || n>=nfiles || files[n]<0) {errno=EBADF;return -1;}return files[n]; }
int main(void) {
  /* The JS owner defers termination until transaction cleanup completes.
   * Group-delivered terminal signals must not revoke its live capabilities.
   * Parent death closes stdin, so the loop exits without a signal handler. */
  signal(SIGINT,SIG_IGN);signal(SIGTERM,SIG_IGN);signal(SIGHUP,SIG_IGN);
  int root=open("/",DIRECTORY_ACCESS|O_DIRECTORY|O_CLOEXEC);struct stat rs;
  if(root<0 || fstat(root,&rs)<0)return 1;
  dirs[ndirs++]=(struct directory){root,-1,strdup("/"),strdup(""),rs.st_dev,rs.st_ino};
  for(;;) {
    unsigned char header[4]; if(readall(0,header,4))break;
    uint32_t length=get32(header);if(length<2 || length>LIMIT) return 2;
    unsigned char *request=malloc(length+1);if(!request)return 3;
    if(readall(0,request,length)) {free(request);break;}request[length]=0;
    int op=request[0],argc=request[1];char *args[8]={0};size_t pos=2;int malformed=argc>8;
    for(int i=0;i<argc && !malformed;i++) {
      if(pos+4>length) {malformed=1;break;}
      uint32_t len=get32(request+pos);pos+=4;
      if(pos+len>length || memchr(request+pos,0,len)) {malformed=1;break;}
      args[i]=malloc(len+1);if(!args[i]) {malformed=1;break;}
      memcpy(args[i],request+pos,len);args[i][len]=0;pos+=len;
    }
    int error=0; unsigned char out[STAT_BYTES];void *output=out;uint32_t outlen=0;
    int parent=-1,fd=-1,result=-1;char *name=NULL;struct stat st;
    errno=0;
    if(malformed) error=EINVAL;
    else switch(op) {
      case 1: /* lstat: never follows the final entry */
        if(argc!=1) {error=EINVAL;break;}
        if(!strcmp(args[0],"/")) result=fstat(root,&st);
        else {parent=parent_for(args[0],&name);if(parent<0)break;result=fstatat(dirs[parent].fd,name,&st,AT_SYMLINK_NOFOLLOW);}
        if(!result) {
          if(S_ISDIR(st.st_mode)) {
            int pinned=directory(args[0]);struct stat opened;
            if(pinned<0) {result=-1;break;}
            if(fstat(dirs[pinned].fd,&opened)<0 || opened.st_dev!=st.st_dev || opened.st_ino!=st.st_ino) {errno=ESTALE;result=-1;break;}
          }
          statbytes(out,&st);outlen=STAT_BYTES;if(parent>=0 && !S_ISLNK(st.st_mode))remember(parent,name,&st);
        }
        break;
      case 2: /* open: protocol flags are independent of host constants */
        if(argc!=3) {error=EINVAL;break;}
        parent=parent_for(args[0],&name);if(parent<0)break;
        int kind=atoi(args[1]),flags=O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK;
        if(kind==0)flags|=O_RDONLY;else if(kind==1)flags|=O_RDWR;else if(kind==2)flags|=O_WRONLY|O_CREAT|O_EXCL;else {error=EINVAL;break;}
        if(kind!=0 && !mutable_parent(parent))break;
        fd=openat(dirs[parent].fd,name,flags,strtoul(args[2],NULL,10)&0777);
        if(fd<0)break;
        if(fstat(fd,&st)<0 || (!S_ISREG(st.st_mode) && !(kind==0 && S_ISDIR(st.st_mode))) || (S_ISREG(st.st_mode) && st.st_nlink!=1)) {close(fd);fd=-1;errno=ELOOP;break;}
        if(nfiles>=MAX_HANDLES) {close(fd);errno=EMFILE;break;}
        if((kind==2?own(parent,name,&st):remember(parent,name,&st))<0) {close(fd);break;}
        put32(out,nfiles);outlen=4;files[nfiles++]=fd;result=0;break;
      case 3: /* fstat */
        if(argc!=1) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;result=fstat(fd,&st);if(!result){statbytes(out,&st);outlen=STAT_BYTES;}break;
      case 4: /* bounded read from descriptor */
        if(argc!=1) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;
        if(fstat(fd,&st)<0)break;
        if(!S_ISREG(st.st_mode) || st.st_size<0 || st.st_size>LIMIT) {errno=EFBIG;break;}
        output=malloc(LIMIT+1);if(!output){errno=ENOMEM;break;}
        size_t used=0;ssize_t got;
        while(used<LIMIT && (got=read(fd,(char*)output+used,LIMIT-used))>0)used+=got;
        if(got<0){break;}outlen=used;result=0;break;
      case 5: /* write payload */
        if(argc!=1) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;result=writeall(fd,request+pos,length-pos);break;
      case 6:
        if(argc!=2) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;result=fchmod(fd,strtoul(args[1],NULL,10)&0777);break;
      case 7:
        if(argc!=1) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;result=fsync(fd);break;
      case 8:
        if(argc!=1) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;result=close(fd);files[atoi(args[0])]=-1;break;
      case 9: /* mkdir one basename */
        if(argc!=2) {error=EINVAL;break;}parent=parent_for(args[0],&name);if(!mutable_parent(parent))break;
        result=mkdirat(dirs[parent].fd,name,strtoul(args[1],NULL,10)&0777);
        if(!result && !fstatat(dirs[parent].fd,name,&st,AT_SYMLINK_NOFOLLOW)) {own(parent,name,&st);}
        break;
      case 10: /* rename, anchored at both parents */
        if(argc!=2) {error=EINVAL;break;}parent=parent_for(args[0],&name);if(!mutable_parent(parent) || expected(parent,name,1)<0)break;
        char *destname=NULL;int dest=parent_for(args[1],&destname);
        if(mutable_parent(dest)) {
          if(!fstatat(dirs[dest].fd,destname,&st,AT_SYMLINK_NOFOLLOW) && (S_ISLNK(st.st_mode) || !S_ISREG(st.st_mode) || st.st_nlink!=1 || expected(dest,destname,0)<0)) {errno=ESTALE;}
          else { result=renameat(dirs[parent].fd,name,dirs[dest].fd,destname);if(!result && !fstatat(dirs[dest].fd,destname,&st,AT_SYMLINK_NOFOLLOW))promote(dest,destname,&st); }
        }free(destname);break;
      case 11: case 12: /* unlink/rmdir only an object previously observed */
        if(argc!=1) {error=EINVAL;break;}parent=parent_for(args[0],&name);if(!mutable_parent(parent) || expected(parent,name,1)<0)break;
        result=unlinkat(dirs[parent].fd,name,op==12?AT_REMOVEDIR:0);
        if(!result && op==12) for(int i=1;i<ndirs;i++) if(dirs[i].parent==parent && !strcmp(dirs[i].name,name) && dirs[i].fd>=0) {close(dirs[i].fd);dirs[i].fd=-1;}
        break;
      case 13: /* validate existing directory ancestry */
        if(argc!=1) {error=EINVAL;break;}parent=directory(args[0]);if(parent<0)break;
        if(current(parent))result=0;else errno=ESTALE;break;
      case 15: /* exclusive hardlink promotion, never follows source */
        if(argc!=2) {error=EINVAL;break;}parent=parent_for(args[0],&name);if(!mutable_parent(parent) || expected(parent,name,1)<0)break;
        char *linkname=NULL;int linkparent=parent_for(args[1],&linkname);
        if(mutable_parent(linkparent)) {result=linkat(dirs[parent].fd,name,dirs[linkparent].fd,linkname,0);if(!result && !fstatat(dirs[linkparent].fd,linkname,&st,AT_SYMLINK_NOFOLLOW))promote(linkparent,linkname,&st);}free(linkname);break;
      case 16: /* positional bounded read */
        if(argc!=3) {error=EINVAL;break;}fd=filefd(args[0]);if(fd<0)break;
        size_t amount=strtoul(args[1],NULL,10);if(amount>LIMIT){error=EFBIG;break;}
        output=malloc(amount?amount:1);if(!output){error=ENOMEM;break;}
        ssize_t count=pread(fd,output,amount,strtoll(args[2],NULL,10));if(count>=0){outlen=count;result=0;}break;
      case 14:
        if(argc!=1 || (strcmp(args[0],"0") && strcmp(args[0],"1"))) {error=EINVAL;break;}rollback_mode=atoi(args[0]);result=0;break;
      default:error=EINVAL;
    }
    if(!error && result<0)error=errno?errno:EIO;
    if(reply(error,error?NULL:output,error?0:outlen))return 4;
    if(output!=out)free(output);
    free(name);for(int i=0;i<argc && i<8;i++)free(args[i]);free(request);
  }
  return 0;
}
