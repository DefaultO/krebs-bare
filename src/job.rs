//! A match's server has a memory limit of its own, and goes when this server goes. WebAssembly memory passes the per-bot
//! limit, so without this one bot could fill the host's PC. Windows holds the limit in a Job Object: past it an allocation
//! fails, and the job tells a port that it did. When the job's last handle closes, as it does however this server ends,
//! Windows ends the child too. Elsewhere than Windows there is no limit.

use std::process::Child;

#[cfg(windows)]
pub(crate) use windows::Job;

#[cfg(windows)]
mod windows {
    use super::Child;
    use std::ffi::c_void;
    use std::io::Error;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

    const BASIC_AND_EXTENDED_LIMITS: i32 = 9;
    const COMPLETION_PORT: i32 = 7;
    const LIMIT_PROCESS_MEMORY: u32 = 0x100;
    /// No crash dialog, which would wait for someone to click it with the match hanging.
    const LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x400;
    const LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const MESSAGE_PROCESS_MEMORY_LIMIT: u32 = 9;

    /// JOBOBJECT_BASIC_LIMIT_INFORMATION.
    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        per_process_user_time: i64,
        per_job_user_time: i64,
        flags: u32,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_processes: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    /// JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
    #[repr(C)]
    #[derive(Default)]
    struct Limits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    /// JOBOBJECT_ASSOCIATE_COMPLETION_PORT.
    #[repr(C)]
    struct PortLink {
        key: usize,
        port: RawHandle,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> RawHandle;
        fn SetInformationJobObject(job: RawHandle, class: i32, information: *const c_void, size: u32) -> i32;
        fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
        fn CreateIoCompletionPort(file: RawHandle, port: RawHandle, key: usize, threads: u32) -> RawHandle;
        fn GetQueuedCompletionStatus(port: RawHandle, message: *mut u32, key: *mut usize, data: *mut *mut c_void, wait_ms: u32) -> i32;
    }

    /// A handle a call just made, which then belongs to this.
    fn owned(handle: RawHandle) -> std::io::Result<OwnedHandle> {
        if handle.is_null() {
            return Err(Error::last_os_error());
        }
        // SAFETY: Windows gave it out just now, nothing else holds it, and it is closed once, by this.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    fn set<T>(job: &OwnedHandle, class: i32, information: &T) -> std::io::Result<()> {
        // SAFETY: `information` is valid for its size for this call, and Windows copies it.
        match unsafe { SetInformationJobObject(job.as_raw_handle(), class, (information as *const T).cast(), size_of::<T>() as u32) } {
            0 => Err(Error::last_os_error()),
            _ => Ok(()),
        }
    }

    pub(crate) struct Job {
        // holding this open is what keeps the child alive
        _job: OwnedHandle,
        port: OwnedHandle,
        over: bool,
    }

    impl Job {
        /// Holds `child` to `bytes` of memory, for as long as this lives. A child that has only just been started and is
        /// waiting for its password has run nothing of anyone's yet.
        pub(crate) fn limit(child: &Child, bytes: u64) -> std::io::Result<Job> {
            let no_file = usize::MAX as RawHandle;
            // SAFETY: nulls are what these take for no name and no security settings, and for a new port.
            let (job, port) = unsafe { (owned(CreateJobObjectW(std::ptr::null(), std::ptr::null()))?, owned(CreateIoCompletionPort(no_file, std::ptr::null_mut(), 0, 1))?) };
            set(&job, COMPLETION_PORT, &PortLink { key: 0, port: port.as_raw_handle() })?;
            let basic = BasicLimits { flags: LIMIT_PROCESS_MEMORY | LIMIT_KILL_ON_JOB_CLOSE | LIMIT_DIE_ON_UNHANDLED_EXCEPTION, ..BasicLimits::default() };
            set(&job, BASIC_AND_EXTENDED_LIMITS, &Limits { basic, process_memory: bytes as usize, ..Limits::default() })?;
            // SAFETY: both handles are open, and `child` still holds its process's even if that has ended.
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
                return Err(Error::last_os_error());
            }
            Ok(Job { _job: job, port, over: false })
        }

        /// Whether the child has been refused memory by the limit, at any time so far. Does not wait.
        pub(crate) fn over_limit(&mut self) -> bool {
            let (mut message, mut key, mut data) = (0u32, 0usize, std::ptr::null_mut());
            // SAFETY: the port is open and the three are written; a wait of 0 returns at once, with 0 when nothing is left.
            while unsafe { GetQueuedCompletionStatus(self.port.as_raw_handle(), &mut message, &mut key, &mut data, 0) } != 0 {
                self.over |= message == MESSAGE_PROCESS_MEMORY_LIMIT;
            }
            self.over
        }
    }
}

#[cfg(not(windows))]
pub(crate) struct Job;

#[cfg(not(windows))]
impl Job {
    pub(crate) fn limit(_child: &Child, _bytes: u64) -> std::io::Result<Job> {
        Ok(Job)
    }

    pub(crate) fn over_limit(&mut self) -> bool {
        false
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// A process that waits on its stdin, which ends with this test.
    fn waiting() -> Child {
        let cmd = backend::steam_web::system_program("cmd");
        Command::new(cmd).args(["/c", "more"]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
    }

    #[test]
    fn a_child_ends_with_its_job() {
        let mut child = waiting();
        let job = Job::limit(&child, 1 << 30).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(std::time::Instant::now() < end, "it is still there");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[test]
    fn a_limit_refuses_nothing_on_its_own() {
        let mut child = waiting();
        let mut job = Job::limit(&child, 1 << 30).unwrap();
        assert!(!job.over_limit(), "only a refused allocation counts");
        let _ = child.kill();
        let _ = child.wait();
    }
}
