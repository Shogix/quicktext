var EXPORTED_SYMBOLS = ["wzQuicktextVar"];

var Services = globalThis.Services || ChromeUtils.import(
  "resource://gre/modules/Services.jsm"
).Services;
var { gQuicktext } = ChromeUtils.import("chrome://quicktext/content/modules/wzQuicktext.jsm");
var { MailServices } = ChromeUtils.import("resource:///modules/MailServices.jsm");

var { XPCOMUtils } = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetters(this, {
  newUID: "resource:///modules/AddrBookUtils.jsm",
  AddrBookCard: "resource:///modules/AddrBookCard.jsm",
  BANISHED_PROPERTIES: "resource:///modules/VCardUtils.jsm",
  VCardProperties: "resource:///modules/VCardUtils.jsm",
  VCardUtils: "resource:///modules/VCardUtils.jsm",
});

const kDebug          = true;
const persistentTags  = ['COUNTER', 'ORGATT', 'ORGHEADER', 'VERSION'];

function wzQuicktextVar()
{
  this.mData        = {};
  this.mWindow      = null;

  // Need the Main Quicktext component
  this.mQuicktext = gQuicktext;
}

wzQuicktextVar.prototype = {
  init: function(aWindow)
  {
    // Save the window we are in
    this.mWindow = aWindow;

    // New mail so we need to destroy all tag-data
    this.mData = {};
  }
,
  cleanTagData: function()
  {
    // Just save some of the tag-data.
    var tmpData = {};
    for (var i in this.mData)
    {
      if (persistentTags.indexOf(i) > -1)
        tmpData[i] = this.mData[i];
    }
    this.mData = tmpData;
  }
,
  // The get-functions takes the data from the process-functions and
  // returns string depending of what aVariables is

  get_file: function(aVariables)
  {
    return this.process_file(aVariables);
  }
,
  get_image: function(aVariables, aType)
  {
    if (aType == 1) {
      // image tag may only be added in html mode
      return this.process_image_content(aVariables);
    } else {
      return "";
    }
  }
,
  get_text: function(aVariables)
  {
    return this.process_text(aVariables);
  }
,
  get_script: async function(aVariables)
  {
    return await this.process_script(aVariables);
  }
,

  get_selection: function(aVariables, aType)
  {
    return this.process_selection(aVariables, aType);
  }
,

  get_url: async function(aVariables)
  {
    return await this.process_url(aVariables);
  }


,
  // These process functions get the data and mostly saves it
  // in this.mData so if the data is requested again it is quick

  process_file: function(aVariables)
  {
    if (aVariables.length > 0 && aVariables[0] != "")
    {
      // Tries to open the file and returning the content
      var fp = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      try {
        aVariables[0] = this.mQuicktext.parseFilePath(aVariables[0]);
        fp.initWithPath(aVariables[0]);
        let content = this.mQuicktext.readFile(fp);
        if (aVariables.length > 1 && aVariables[1].includes("strip_html_comments")) {
          return content.replace(/<!--[\s\S]*?(?:-->)/g, '');
        }
        return content;
      } catch(e) { console.error(e); }
    }

    return "";
  }
,
  process_image_content: function(aVariables)
  {
    let rv = "";
    
    if (aVariables.length > 0 && aVariables[0] != "")
    {
      let mode = (aVariables.length > 1 && "src" == aVariables[1].toString().toLowerCase()) ? "src" : "tag";
      
      // Tries to open the file and returning the content
      try {
        let fp = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
        fp.initWithPath(this.mQuicktext.parseFilePath(aVariables[0]));
        let rawContent = this.mQuicktext.readBinaryFile(fp);
        let decoder = new TextDecoder('utf-8');
        let content = this.mWindow.btoa(rawContent);
        let type = this.mQuicktext.getTypeFromExtension(fp);
        let src = "data:" + type + ";filename=" + fp.leafName + ";base64," + content;
        rv = (mode == "tag") 
                ? "<img src='"+src+"'>"
                : src;
      } catch(e) { 
        console.error(e); 
      }
    }

    return rv;
  }
,
  process_text: function(aVariables)
  {
    if (aVariables.length != 2)
      return "";

    // Looks after the group and text-name and returns
    // the text from it
    var groupLength = this.mQuicktext.getGroupLength(false);
    for (var j = 0; j < groupLength; j++)
    {
      if (aVariables[0] == this.mQuicktext.getGroup(j, true).name)
      {
        var textLength = this.mQuicktext.getTextLength(j, false);
        for (var k = 0; k < textLength; k++)
        {
          var text = this.mQuicktext.getText(j, k, false);
          if (aVariables[1] == text.name)
          {
            return text.text;
          }
        }
      }
    }

    return "";
  }
,
  process_script: async function(aVariables)
  {
    if (aVariables.length == 0)
      return "";
    
    var scriptName = aVariables.shift();

    // Looks through all scripts and tries to find the 
    // one we look for
    var scriptLength = this.mQuicktext.getScriptLength(false);
    for (var i = 0; i < scriptLength; i++)
    {
      var script = this.mQuicktext.getScript(i, false);
      if (script.name == scriptName)
      {
        let returnValue = "";
        
        var referenceLineNumber = 0
        try {
          var error = variableNotAvailable; // provoke an error to create a reference for the other linenumber
        } catch (eReference) {
          referenceLineNumber = eReference.lineNumber;
        }
        
        try {
          var s = Components.utils.Sandbox(this.mWindow);
          s.mQuicktext = this;
          s.mVariables = aVariables;
          s.mWindow = this.mWindow;
          returnValue = await Components.utils.evalInSandbox("scriptObject = {}; scriptObject.mQuicktext = mQuicktext; scriptObject.mVariables = mVariables; scriptObject.mWindow = mWindow; scriptObject.run = async function() {\n" + script.script +"\n; return ''; }; scriptObject.run();", s);
        } catch (e) {
          if (this.mWindow)
          {
            var lines = script.script.split("\n");
            
            // Takes the linenumber where the error where and remove
            // the line that it was run on so we get the line in the script
            // calculate it by using a reference error linenumber and an offset
            // offset: 10 lines between "variableNotAvailable" and "evalInSandbox"
            var lineNumber = e.lineNumber - referenceLineNumber - 10;
            this.mWindow.alert(gQuicktext.mStringBundle.GetStringFromName("scriptError") + " " + script.name + "\n" + e.name + ": "+ e.message + "\n" + gQuicktext.mStringBundle.GetStringFromName("scriptLine") + " " + lineNumber + ": " + lines[lineNumber-1]);
          }
        }

        return returnValue;
      }
    }

    //if we reach this point, the user requested an non-existing script
    this.mWindow.alert(gQuicktext.mStringBundle.formatStringFromName("scriptNotFound", [scriptName], 1))
    return "";
  }
,
  process_selection: function(aVariables, aType)
  {
    if (aType == 0) {
      // return selected text as plain text
      return this.mQuicktext.mSelectionContent;
    } else {
      // return selected text as html
      return this.mQuicktext.mSelectionContentHtml;
    }
  }
,

  process_url: async function(aVariables)
  {
    if (aVariables.length == 0)
      return "";

    var url = aVariables.shift();

    if (url != "")
    {
      var debug = false;
      var method = "post";
      var post = [];
      
      if (aVariables.length > 0)
      {
        var variables = aVariables.shift().split(";");
        for (var k = 0; k < variables.length; k++)
        {
          var tag = variables[k].toLowerCase();
          var data = null;

          switch (tag)
          {
            case 'to':
            case 'att':
            case 'orgheader':
            case 'orgatt':
              data = await this["process_"+ tag]();
              if (typeof data != 'undefined')
              {
                for (var i in data)
                  for (var j in data[i])
                    post.push(tag +'['+ i +']['+ j +']='+ data[i][j]);
              }
              break;
            case 'from':
            case 'version':
            case 'date':
            case 'time':
              data = await this["process_"+ tag]();
              if (typeof data != 'undefined')
              {
                for (var i in data)
                  post.push(tag +'['+ i +']='+ data[i]);
              }
              break;
            case 'subject':
            case 'clipboard':
            case 'selection':
            case 'counter':
              data = await this["process_"+ tag]();
              if (typeof data != 'undefined')
                post.push(tag +'='+ data);
              break;

            case 'post':
            case 'get':
            case 'options':
              method = tag;
              break;

            case 'debug':
              debug = true;
              break;
          }
        }
      }

      var req = new XMLHttpRequest();
      req.open(method, url, true);
      if (method == "post") req.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
      let response = "";

      //Lazy async-to-sync implementation with ACK from Philipp Kewisch
      //http://lists.thunderbird.net/pipermail/maildev_lists.thunderbird.net/2018-June/001205.html
      let inspector = Components.classes["@mozilla.org/jsinspector;1"].createInstance(Components.interfaces.nsIJSInspector);
      
      req.ontimeout = function () {
        if (debug) response = "Quicktext timeout";
        inspector.exitNestedEventLoop();
      };

      req.onerror = function () {
        if (debug) response = "error (" + req.status + ")";
        inspector.exitNestedEventLoop();
      };

      req.onload = function() {
        if (req.status == 200) response = req.responseText;
        else 	if (debug) response = "error (" + req.status + ")";
        inspector.exitNestedEventLoop();
      };

      if (method == "post") req.send(post.join("&"));
      else req.send();

      inspector.enterNestedEventLoop(0); /* wait for async process to terminate */
      return response;
    }

    return "";
  }

}


var debug = kDebug ?  function(m) {dump("\t *** wzQuicktext: " + m + "\n");} : function(m) {};

