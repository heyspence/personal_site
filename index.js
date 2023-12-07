const dashDoorViewButton = document.querySelector('.view-dash-door')
const dashDoorIframe = document.querySelector('.dash-door-iframe')


const toggleIHidden = (element) => {
    if(element.classList.contains("hidden")){
        element.classList.remove("hidden")
    }else{
        element.classList.add("hidden")
    }
}
dashDoorViewButton.addEventListener("click", ()=>{
    toggleIHidden(dashDoorIframe)
})