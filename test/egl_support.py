"""Minimal optional EGL harness for shader parity tests (Mesa surfaceless, not a browser)."""
import ctypes as C
import os
os.environ.setdefault('EGL_PLATFORM', 'surfaceless')
class EGL:
 def __init__(self):
  self.e=C.CDLL('libEGL.so.1'); e=self.e
  self._egl('eglGetProcAddress',C.c_void_p,[C.c_char_p])
  self._egl('eglGetDisplay',C.c_void_p,[C.c_void_p])
  self._egl('eglInitialize',C.c_uint,[C.c_void_p,C.POINTER(C.c_int),C.POINTER(C.c_int)])
  self._egl('eglBindAPI',C.c_uint,[C.c_uint])
  self._egl('eglChooseConfig',C.c_uint,[C.c_void_p,C.POINTER(C.c_int),C.POINTER(C.c_void_p),C.c_int,C.POINTER(C.c_int)])
  self._egl('eglCreateContext',C.c_void_p,[C.c_void_p,C.c_void_p,C.c_void_p,C.POINTER(C.c_int)])
  self._egl('eglCreatePbufferSurface',C.c_void_p,[C.c_void_p,C.c_void_p,C.POINTER(C.c_int)])
  self._egl('eglMakeCurrent',C.c_uint,[C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p])
  self._egl('eglGetError',C.c_uint,[])
  d=e.eglGetDisplay(None);major=C.c_int();minor=C.c_int()
  if not e.eglInitialize(d,C.byref(major),C.byref(minor)): raise RuntimeError(f'EGL initialize failed: {e.eglGetError():x}')
  assert e.eglBindAPI(0x30A0)
  attrs=(C.c_int*13)(0x3033,1,0x3040,0x40,0x3024,8,0x3023,8,0x3022,8,0x3021,8,0x3038)
  cfg=C.c_void_p();n=C.c_int();assert e.eglChooseConfig(d,attrs,C.byref(cfg),1,C.byref(n)) and n.value
  ctx=e.eglCreateContext(d,cfg,None,(C.c_int*3)(0x3098,3,0x3038))
  surf=e.eglCreatePbufferSurface(d,cfg,(C.c_int*5)(0x3057,1,0x3056,1,0x3038))
  assert ctx and surf and e.eglMakeCurrent(d,surf,surf,ctx)
  self.display,self.context,self.surface=d,ctx,surf
 def _egl(self,n,r,a):
  f=getattr(self.e,n);f.restype=r;f.argtypes=a;return f
 def fn(self,n,r,a):
  addr=self.e.eglGetProcAddress(n.encode())
  if not addr: raise RuntimeError(n+' unavailable')
  f=C.CFUNCTYPE(r,*a)(addr);setattr(self,n,f);return f
 def api(self):
  u=C.c_uint;i=C.c_int;p=C.c_void_p;f=C.c_float
  spec={
   'glGetString':(C.c_char_p,[u]),'glGetError':(u,[]),'glCreateShader':(u,[u]),
   'glShaderSource':(None,[u,i,C.POINTER(C.c_char_p),C.POINTER(i)]),'glCompileShader':(None,[u]),
   'glGetShaderiv':(None,[u,u,C.POINTER(i)]),'glGetShaderInfoLog':(None,[u,i,C.POINTER(i),p]),
   'glCreateProgram':(u,[]),'glAttachShader':(None,[u,u]),'glLinkProgram':(None,[u]),
   'glGetProgramiv':(None,[u,u,C.POINTER(i)]),'glGetProgramInfoLog':(None,[u,i,C.POINTER(i),p]),
   'glUseProgram':(None,[u]),'glGenTextures':(None,[i,C.POINTER(u)]),'glBindTexture':(None,[u,u]),
   'glTexParameteri':(None,[u,u,i]),'glTexImage2D':(None,[u,i,i,i,i,i,u,u,p]),
   'glActiveTexture':(None,[u]),'glGetUniformLocation':(i,[u,C.c_char_p]),'glUniform1i':(None,[i,i]),
   'glUniform1f':(None,[i,f]),'glUniform2f':(None,[i,f,f]),'glGenFramebuffers':(None,[i,C.POINTER(u)]),
   'glBindFramebuffer':(None,[u,u]),'glFramebufferTexture2D':(None,[u,u,u,u,i]),
   'glCheckFramebufferStatus':(u,[u]),'glViewport':(None,[i,i,i,i]),'glDrawArrays':(None,[u,i,i]),
   'glReadPixels':(None,[i,i,i,i,u,u,p]),'glGenVertexArrays':(None,[i,C.POINTER(u)]),
   'glBindVertexArray':(None,[u]),'glDeleteProgram':(None,[u]),'glDeleteShader':(None,[u]),
   'glDeleteTextures':(None,[i,C.POINTER(u)]),'glFinish':(None,[]),
  }
  for n,(r,a) in spec.items():self.fn(n,r,a)
  return self
 def program(self,vert,frag):
  shaders=[]
  for typ,src in [(0x8B31,vert),(0x8B30,frag)]:
   sh=self.glCreateShader(typ);text=C.c_char_p(src.encode());self.glShaderSource(sh,1,C.byref(text),None);self.glCompileShader(sh)
   ok=C.c_int();self.glGetShaderiv(sh,0x8B81,C.byref(ok))
   if not ok.value:
    msg=C.create_string_buffer(16384);self.glGetShaderInfoLog(sh,len(msg),None,msg);raise RuntimeError(msg.value.decode())
   shaders.append(sh)
  pr=self.glCreateProgram()
  for sh in shaders:self.glAttachShader(pr,sh)
  self.glLinkProgram(pr);ok=C.c_int();self.glGetProgramiv(pr,0x8B82,C.byref(ok))
  if not ok.value:
   msg=C.create_string_buffer(16384);self.glGetProgramInfoLog(pr,len(msg),None,msg);raise RuntimeError(msg.value.decode())
  for sh in shaders:self.glDeleteShader(sh)
  return pr
if __name__=='__main__':
 g=EGL().api();print(g.glGetString(0x1F02).decode());print(g.glGetString(0x1F01).decode())
