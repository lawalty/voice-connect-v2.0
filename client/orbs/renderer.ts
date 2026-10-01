import type { OrbPack } from './packs';

export interface FaceFrame {
  time: number; yaw: number; pitch: number; roll: number; driftX: number; driftY: number;
  listen: number; think: number; smile: number; blink: number;
  mouth: number; round: number; wide: number; hue: number; sleep: number;
  color: readonly number[];
}
const vertex = `attribute vec2 position; varying vec2 uv;
void main(){uv=vec2(position.x*.5+.5,.5-position.y*.5);gl_Position=vec4(position,0.,1.);}`;
const fragment = `precision highp float;
varying vec2 uv;
uniform sampler2D atlas,flowMap;
uniform float hasFlow,cellSize,time,blink,mouth,roundness,wideness,hue,sleeping,phaseColors;
uniform vec3 expression,turn,color;
uniform vec2 drift;
vec2 cell(float id,vec2 p){p=clamp(p,vec2(.5/cellSize),vec2(1.-.5/cellSize));return (vec2(mod(id,3.),floor(id/3.))+p)/3.;}
vec3 art(float id,vec2 p){return texture2D(atlas,cell(id,p)).rgb;}
vec3 morph(float id,float a,vec2 p){
  if(a<.001)return art(0.,p);
  vec4 flow=hasFlow>.5?(texture2D(flowMap,cell(id,p))*255.-128.)/508.:vec4(0.);
  return mix(art(0.,p-a*flow.rg),art(id,p-(1.-a)*flow.ba),a);
}
vec3 hsv(vec3 c){vec4 K=vec4(0.,-1./3.,2./3.,-1.);vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));float d=q.x-min(q.w,q.y);return vec3(abs(q.z+(q.w-q.y)/(6.*d+.00001)),d/(q.x+.00001),q.x);}
vec3 rgb(vec3 c){vec3 p=abs(fract(c.xxx+vec3(0.,2./3.,1./3.))*6.-3.);return c.z*mix(vec3(1.),clamp(p-1.,0.,1.),c.y);}
void main(){
  vec2 q=(uv-.5-drift)/.80;
  float cs=cos(turn.z),sn=sin(turn.z);
  q=mat2(cs,-sn,sn,cs)*q;
  float radius=length(q)/.427;
  float alpha=1.-smoothstep(.991,1.01,radius);
  vec3 result=vec3(0.);
  if(alpha>.001){
    vec3 sphere=vec3(q/.427,sqrt(max(0.,1.-radius*radius)));
    float x=sphere.x*cos(turn.x)-sphere.z*sin(turn.x);
    float z=sphere.x*sin(turn.x)+sphere.z*cos(turn.x);
    float y=sphere.y*cos(turn.y)+z*sin(turn.y);
    vec2 p=mix(q,vec2(x,y)*.427,1.-smoothstep(.85,1.015,radius))+.5;
    vec3 base=art(0.,p);
    result=base;
    result+=morph(2.,expression.x,p)-base;
    result+=morph(8.,expression.y,p)-base;
    result+=morph(7.,expression.z,p)-base;
    result+=morph(1.,blink,p)-base;
    if(mouth>.001){
      result+=(morph(3.,mouth,p)-base)*max(0.,1.-roundness-wideness);
      result+=(morph(4.,mouth,p)-base)*roundness;
      result+=(morph(5.,mouth,p)-base)*wideness;
    }
    result=clamp(result,0.,1.);
    float shimmer=(sin(p.x*12.8+p.y*6.14+time*1.2)+sin(p.x*7.68-p.y*10.24-time*.73))*.018;
    result*=1.+shimmer*smoothstep(.55,1.,radius);
    if(phaseColors>.5){
      vec3 h=hsv(result);h.x=fract(h.x+hue);h.y*=1.-.32*min(1.,abs(hue)*4.);h.y*=1.-sleeping*.65;
      result=rgb(h)*(1.-sleeping*.16);
    }
  }
  float floorGlow=exp(-pow((uv.x-.5-drift.x*.5)/.19,2.)-pow((uv.y-.884)/.018,2.))*.18;
  float halo=exp(-dot((uv-.5)/.36,(uv-.5)/.36))*.025;
  float glow=(floorGlow+halo)*(1.-alpha);
  vec3 glowColor=phaseColors>.5?color:vec3(.82);
  gl_FragColor=vec4(result*alpha+glowColor*glow,alpha+glow);
}`;

export class GlassFaceRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private textures: WebGLTexture[] = [];
  private locations = new Map<string,WebGLUniformLocation | null>();
  private disposed = false;
  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl',{ alpha:true, antialias:false, depth:false, stencil:false, premultipliedAlpha:true, powerPreference:'low-power' });
    if (!gl) throw new Error('This browser could not display the face.');
    this.gl=gl;
    const compile=(kind:number,source:string)=>{
      const shader=gl.createShader(kind)!;gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);throw new Error('This browser could not display the face.');}
      return shader;
    };
    const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
    const program=this.program=gl.createProgram()!;gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){gl.deleteProgram(program);throw new Error('This browser could not display the face.');}
    gl.useProgram(program);this.buffer=gl.createBuffer()!;gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const at=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(at);gl.vertexAttribPointer(at,2,gl.FLOAT,false,0,0);
  }
  async load(pack: OrbPack, signal: AbortSignal) {
    const images=await Promise.all([pack.atlas,pack.flow || pack.atlas].map(src=>new Promise<HTMLImageElement>((resolve,reject)=>{
      const image=new Image();
      const clear=()=>{image.onload=null;image.onerror=null;signal.removeEventListener('abort',abort);};
      const abort=()=>{clear();image.src='';reject(new DOMException('Aborted','AbortError'));};
      image.onload=()=>{clear();resolve(image);};image.onerror=()=>{clear();reject(new Error('The orb artwork could not be loaded.'));};
      if(signal.aborted){abort();return;}signal.addEventListener('abort',abort,{once:true});image.src=src;
    })));
    if(signal.aborted || this.disposed)return;
    const gl=this.gl;
    for(let i=0;i<images.length;i++){
      const texture=gl.createTexture()!;this.textures.push(texture);gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,images[i]);
    }
    gl.uniform1i(this.location('atlas'),0);gl.uniform1i(this.location('flowMap'),1);
    this.number('hasFlow',pack.flow?1:0);this.number('cellSize',images[0].width/3);
    if(gl.getError()!==gl.NO_ERROR)throw new Error('This browser could not load the face.');
  }
  private location(name:string){if(!this.locations.has(name))this.locations.set(name,this.gl.getUniformLocation(this.program,name));return this.locations.get(name)!;}
  private number(name:string,value:number){this.gl.uniform1f(this.location(name),value);}
  resize(){const n=Math.max(1,Math.round(this.canvas.clientWidth*Math.min(devicePixelRatio||1,1.5)));if(this.canvas.width!==n||this.canvas.height!==n){this.canvas.width=n;this.canvas.height=n;}this.gl.viewport(0,0,n,n);}
  draw(p:FaceFrame,phaseColors=true){
    const gl=this.gl;gl.useProgram(this.program);
    for(const [key,value] of Object.entries({time:p.time,blink:p.blink,mouth:p.mouth,roundness:p.round,wideness:p.wide,hue:p.hue,sleeping:p.sleep}))this.number(key,value);
    this.number('phaseColors',phaseColors?1:0);
    gl.uniform3f(this.location('expression'),p.listen,p.think,p.smile);
    gl.uniform3f(this.location('turn'),p.yaw,p.pitch,p.roll);gl.uniform2f(this.location('drift'),p.driftX,p.driftY);
    gl.uniform3f(this.location('color'),p.color[0],p.color[1],p.color[2]);gl.drawArrays(gl.TRIANGLES,0,6);
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const t of this.textures)this.gl.deleteTexture(t);this.gl.deleteBuffer(this.buffer);this.gl.deleteProgram(this.program);}
}
